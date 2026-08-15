// ============================================================================
// Commit a verified match result to the stats database.
//
// Called ONLY after a moderator clicks Apply and the worker has accepted the
// placements. Rejected proposals never reach this module, so a spoofed or
// misread screenshot cannot poison the stats.
//
// Re-ingest (a moderator applies a corrected screenshot for the same pod)
// replaces the match's team and player rows wholesale. That is deliberate: the
// raw extraction is kept on the matches row, and stat_edits carries name_key
// so a moderator's manual corrections survive as history even though the rows
// they pointed at are gone.
// ============================================================================
const {
  db, toInt, now, embarkKey,
  upsertTournament, upsertTeam, upsertPlayer, upsertTeamMember, resolvePlayer,
} = require("./db");

const stmts = {
  selMatch: db.prepare(`SELECT * FROM matches WHERE tournament_code = ? AND pod_id = ?`),
  insMatch: db.prepare(`
    INSERT INTO matches (
      tournament_code, pod_id, label, map_scheduled, map_observed, on_stream,
      played_at, applied_by, submitted_by, screenshot_sha256, screenshot_url,
      confidence, notes, raw_extraction, created_at, updated_at
    ) VALUES (
      @tournament_code, @pod_id, @label, @map_scheduled, @map_observed, @on_stream,
      @played_at, @applied_by, @submitted_by, @screenshot_sha256, @screenshot_url,
      @confidence, @notes, @raw_extraction, @ts, @ts
    )
    ON CONFLICT(tournament_code, pod_id) DO UPDATE SET
      label             = excluded.label,
      map_scheduled     = excluded.map_scheduled,
      map_observed      = excluded.map_observed,
      on_stream         = excluded.on_stream,
      played_at         = excluded.played_at,
      applied_by        = excluded.applied_by,
      submitted_by      = excluded.submitted_by,
      screenshot_sha256 = excluded.screenshot_sha256,
      screenshot_url    = excluded.screenshot_url,
      confidence        = excluded.confidence,
      notes             = excluded.notes,
      raw_extraction    = excluded.raw_extraction,
      updated_at        = excluded.updated_at
  `),
  clearTeams: db.prepare(`DELETE FROM match_teams WHERE match_id = ?`),
  insMatchTeam: db.prepare(`
    INSERT INTO match_teams (match_id, team_id, squad_label, placement, placement_observed, cash, slot)
    VALUES (@match_id, @team_id, @squad_label, @placement, @placement_observed, @cash, @slot)
  `),
  insMatchPlayer: db.prepare(`
    INSERT INTO match_players (
      match_id, match_team_id, player_id, name_observed, name_key, class,
      eliminations, assists, deaths, revives, combat, support, objective, disconnected
    ) VALUES (
      @match_id, @match_team_id, @player_id, @name_observed, @name_key, @class,
      @eliminations, @assists, @deaths, @revives, @combat, @support, @objective, @disconnected
    )
    ON CONFLICT(match_id, name_key) DO UPDATE SET
      match_team_id = excluded.match_team_id,
      player_id     = excluded.player_id,
      class         = excluded.class,
      eliminations  = excluded.eliminations,
      assists       = excluded.assists,
      deaths        = excluded.deaths,
      revives       = excluded.revives,
      combat        = excluded.combat,
      support       = excluded.support,
      objective     = excluded.objective,
      disconnected  = excluded.disconnected
  `),
};

// Register every team + roster in the bracket, so a player who never appears
// on a scoreboard still exists in the database and searches find their team.
function syncRosters(tournamentCode, state) {
  for (const seed of state.seeds || []) {
    if (!seed.name) continue;
    const teamId = upsertTeam(tournamentCode, seed.name);
    const players = seed.players || [];
    const discords = seed.discords || [];
    players.forEach((embarkId, i) => {
      if (!embarkId) return;
      const playerId = upsertPlayer(embarkId, discords[i] || null);
      if (playerId) upsertTeamMember(teamId, playerId, discords[i] || null, false);
    });
  }
}

/**
 * @param {object} arg
 * @param {string} arg.code           tournament session code (CB-XXXX)
 * @param {object} arg.state          live bracket state
 * @param {object} arg.pod            the pod being resolved
 * @param {object} arg.verdict        raw vision output
 * @param {Array}  arg.assignments    from rosters.derivePlacements
 * @param {object} arg.placements     { teamName: 1..n } as applied to the worker
 * @param {string} arg.appliedBy      moderator discord username
 * @param {string} arg.submittedBy    screenshot author discord username
 * @param {string} arg.sha256
 * @param {string} arg.screenshotUrl
 * @returns {{matchId:number, players:number, teams:number}}
 */
function commitMatch(arg) {
  const {
    code, state, pod, verdict, assignments, placements,
    appliedBy, submittedBy, sha256, screenshotUrl,
  } = arg;

  const run = db.transaction(() => {
    upsertTournament(code, state.name || null);
    syncRosters(code, state);

    const ts = now();
    stmts.insMatch.run({
      tournament_code: code,
      pod_id: pod.id,
      label: pod.label || null,
      map_scheduled: pod.map || null,
      map_observed: verdict.map_name || null,
      on_stream: pod.onStream || pod.liveNow ? 1 : 0,
      played_at: ts,
      applied_by: appliedBy || null,
      submitted_by: submittedBy || null,
      screenshot_sha256: sha256 || null,
      screenshot_url: screenshotUrl || null,
      confidence: verdict.confidence || null,
      notes: verdict.notes || null,
      raw_extraction: JSON.stringify(verdict),
      ts,
    });

    const match = stmts.selMatch.get(code, pod.id);
    stmts.clearTeams.run(match.id);   // cascades to match_players

    let teamCount = 0, playerCount = 0;
    assignments.forEach((a, slot) => {
      const teamId = a.team ? upsertTeam(code, a.team) : null;
      const matchTeamId = Number(stmts.insMatchTeam.run({
        match_id: match.id,
        team_id: teamId,
        squad_label: a.squad.squad_label || null,
        // Bracket placement only exists for teams that are actually in the pod.
        placement: a.team ? (placements[a.team] || null) : null,
        placement_observed: Number.isFinite(a.squad.placement) ? a.squad.placement : null,
        cash: toInt(a.squad.cash),
        slot,
      }).lastInsertRowid);
      teamCount++;

      for (const p of a.squad.players || []) {
        const nameKey = embarkKey(p.name);
        if (!nameKey) continue;
        // Only players on a registered roster become tracked identities;
        // opponents from outside the tournament stay as observed names.
        let playerId = null;
        if (a.team) {
          const known = resolvePlayer(p.name);
          playerId = known ? known.id : null;
        }
        stmts.insMatchPlayer.run({
          match_id: match.id,
          match_team_id: matchTeamId,
          player_id: playerId,
          name_observed: String(p.name).trim(),
          name_key: nameKey,
          class: p.class || null,
          eliminations: toInt(p.eliminations),
          assists: toInt(p.assists),
          deaths: toInt(p.deaths),
          revives: toInt(p.revives),
          combat: toInt(p.combat),
          support: toInt(p.support),
          objective: toInt(p.objective),
          disconnected: p.disconnected ? 1 : 0,
        });
        playerCount++;
      }
    });

    return { matchId: match.id, teams: teamCount, players: playerCount };
  });

  return run();
}

module.exports = { commitMatch, syncRosters };
