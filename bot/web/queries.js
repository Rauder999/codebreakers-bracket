// ============================================================================
// Read side of the stats store: search, profiles, and the on-demand aggregate
// engine that every "average" in the UI is built on.
//
// Everything funnels through buildAggregate(), which composes SQL from a
// WHITELIST of dimensions and filters. Nothing from the request ever reaches
// the SQL text -- values go in as bound parameters, and names are looked up in
// the tables below. If you add a dimension, add it there, not inline.
//
// No ratio is ever stored. kd, per-match averages and win rate are derived
// here from sums, so a moderator correcting one bad OCR read instantly fixes
// every derived number that depends on it.
// ============================================================================
const { db } = require("../stats/db");

// --- dimension + metric whitelists -----------------------------------------

// v_player_match holds one row per PLAYER per match, so what counts as "a
// match" depends on the grouping:
//
//   * player  -- a player has exactly one row per match, so rows ARE matches.
//   * team    -- a squad has one row per player per match. Counting rows made
//                a team that had played a single 3-player match report "3
//                matches, 3 won", and divided every per-match average by the
//                size of the squad. Count the match itself.
//   * match   -- likewise: every row belongs to the same one match.
//   * class / map / tournament -- rows are independent player appearances that
//                happen to share a match, and "combat per match" for Heavy
//                means per heavy player per match. Rows are the right unit;
//                counting distinct matches here would merge separate players.
//
// perMatch marks the groupings where many rows are ONE participation.
const ROWS = "COUNT(*)";
const DISTINCT_MATCHES = "COUNT(DISTINCT vpm.match_id)";
const countFor = (dim) => (dim.perMatch ? DISTINCT_MATCHES : ROWS);
const winsFor = (dim) => (dim.perMatch
  ? "COUNT(DISTINCT CASE WHEN vpm.placement = 1 THEN vpm.match_id END)"
  : "SUM(CASE WHEN vpm.placement = 1 THEN 1 ELSE 0 END)");

const DIMENSIONS = {
  player:     { select: "vpm.player_id AS key, p.embark_id AS label", join: "JOIN players p ON p.id = vpm.player_id", group: "vpm.player_id", requires: "vpm.player_id IS NOT NULL" },
  team:       { select: "vpm.team_id AS key, t.name AS label",        join: "JOIN teams t ON t.id = vpm.team_id",      group: "vpm.team_id",   requires: "vpm.team_id IS NOT NULL", perMatch: true },
  class:      { select: "vpm.class AS key, vpm.class AS label",       join: "",                                        group: "vpm.class",     requires: "vpm.class IS NOT NULL" },
  map:        { select: "vpm.map AS key, vpm.map AS label",           join: "",                                        group: "vpm.map",       requires: "vpm.map IS NOT NULL" },
  tournament: { select: "vpm.tournament_code AS key, COALESCE(tn.name, vpm.tournament_code) AS label", join: "LEFT JOIN tournaments tn ON tn.code = vpm.tournament_code", group: "vpm.tournament_code", requires: "" },
  match:      { select: "vpm.match_id AS key, vpm.label AS label",    join: "",                                        group: "vpm.match_id",  requires: "", perMatch: true },
};

// Sums are the only thing aggregated; every rate below is derived from them.
const sumsFor = (dim) => `
  ${countFor(dim)}                                      AS matches,
  COALESCE(SUM(vpm.eliminations), 0)                    AS eliminations,
  COALESCE(SUM(vpm.assists), 0)                         AS assists,
  COALESCE(SUM(vpm.deaths), 0)                          AS deaths,
  COALESCE(SUM(vpm.revives), 0)                         AS revives,
  COALESCE(SUM(vpm.combat), 0)                          AS combat,
  COALESCE(SUM(vpm.support), 0)                         AS support,
  COALESCE(SUM(vpm.objective), 0)                       AS objective,
  ${winsFor(dim)}                                       AS wins,
  AVG(CAST(vpm.placement AS REAL))                      AS avg_placement
`;

// Sort keys the client may ask for, mapped to the derived expression. The
// per-match ones divide by whatever a match means for this grouping.
const sortableFor = (dim) => {
  const M = countFor(dim);
  return {
    matches: "matches", eliminations: "eliminations", assists: "assists",
    deaths: "deaths", revives: "revives", combat: "combat", support: "support",
    objective: "objective", wins: "wins", avg_placement: "avg_placement",
    kd: "CASE WHEN SUM(vpm.deaths) > 0 THEN CAST(SUM(vpm.eliminations) AS REAL) / SUM(vpm.deaths) ELSE CAST(SUM(vpm.eliminations) AS REAL) END",
    elims_per_match: `CAST(SUM(vpm.eliminations) AS REAL) / ${M}`,
    combat_per_match: `CAST(SUM(vpm.combat) AS REAL) / ${M}`,
    support_per_match: `CAST(SUM(vpm.support) AS REAL) / ${M}`,
    objective_per_match: `CAST(SUM(vpm.objective) AS REAL) / ${M}`,
    revives_per_match: `CAST(SUM(vpm.revives) AS REAL) / ${M}`,
    label: "label",
  };
};

// The sort whitelist is the same set of keys for every dimension; the shape is
// what the API validates against.
const SORTABLE = sortableFor({});

// Derive every rate from the summed row, in one place.
function decorate(row) {
  const n = row.matches || 0;
  const per = (v) => (n ? Number((v / n).toFixed(2)) : 0);
  return {
    ...row,
    // deaths = 0 is a real (excellent) result, not a divide-by-zero.
    kd: Number((row.deaths > 0 ? row.eliminations / row.deaths : row.eliminations).toFixed(2)),
    kda: Number((row.deaths > 0 ? (row.eliminations + row.assists) / row.deaths : row.eliminations + row.assists).toFixed(2)),
    win_rate: n ? Number(((row.wins / n) * 100).toFixed(1)) : 0,
    avg_placement: row.avg_placement == null ? null : Number(row.avg_placement.toFixed(2)),
    elims_per_match: per(row.eliminations),
    assists_per_match: per(row.assists),
    deaths_per_match: per(row.deaths),
    revives_per_match: per(row.revives),
    combat_per_match: per(row.combat),
    support_per_match: per(row.support),
    objective_per_match: per(row.objective),
  };
}

// --- filters ----------------------------------------------------------------

function buildWhere(f = {}) {
  const where = [];
  const params = {};
  const add = (sql, key, value) => { where.push(sql); params[key] = value; };

  if (f.tournament) add("vpm.tournament_code = @tournament", "tournament", f.tournament);
  if (f.player_id)  add("vpm.player_id = @player_id", "player_id", Number(f.player_id));
  if (f.team_id)    add("vpm.team_id = @team_id", "team_id", Number(f.team_id));
  if (f.match_id)   add("vpm.match_id = @match_id", "match_id", Number(f.match_id));
  if (f.class)      add("vpm.class = @class", "class", String(f.class).toUpperCase());
  if (f.map)        add("vpm.map = @map", "map", f.map);
  if (f.from)       add("vpm.played_at >= @from", "from", Number(f.from));
  if (f.to)         add("vpm.played_at <= @to", "to", Number(f.to));
  // Disconnected rows carry partial stats; excluded by default, opt back in.
  if (!f.include_disconnected) where.push("vpm.disconnected = 0");

  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/**
 * The one aggregate query behind every leaderboard, profile split and average.
 *
 * @param {string} groupBy   key of DIMENSIONS
 * @param {object} filters   see buildWhere
 * @param {object} opts      { sort, dir, limit, offset, minMatches }
 */
function buildAggregate(groupBy, filters = {}, opts = {}) {
  const dim = DIMENSIONS[groupBy];
  if (!dim) throw new Error(`unknown group_by: ${groupBy}`);

  const { sql: whereSql, params } = buildWhere(filters);
  const where = dim.requires
    ? (whereSql ? `${whereSql} AND ${dim.requires}` : `WHERE ${dim.requires}`)
    : whereSql;

  const sortKeys = sortableFor(dim);
  const sortExpr = sortKeys[opts.sort] || sortKeys.matches;
  const dir = String(opts.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const minMatches = Number(opts.minMatches) > 0 ? Number(opts.minMatches) : 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const sql = `
    SELECT ${dim.select}, ${sumsFor(dim)}
    FROM v_player_match vpm
    ${dim.join}
    ${where}
    GROUP BY ${dim.group}
    ${minMatches ? `HAVING ${countFor(dim)} >= ${minMatches}` : ""}
    ORDER BY ${sortExpr} ${dir} NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
  return db.prepare(sql).all(params).map(decorate);
}

// --- search -----------------------------------------------------------------

const searchPlayersStmt = db.prepare(`
  SELECT p.id, p.embark_id, p.discord_username,
         (SELECT COUNT(*) FROM match_players mp WHERE mp.player_id = p.id) AS matches,
         (SELECT GROUP_CONCAT(DISTINCT t.name)
            FROM team_members tm JOIN teams t ON t.id = tm.team_id
           WHERE tm.player_id = p.id) AS teams
    FROM players p
   WHERE p.embark_key LIKE @q OR LOWER(COALESCE(p.discord_username, '')) LIKE @q
   ORDER BY matches DESC, p.embark_id ASC
   LIMIT @limit
`);

function searchPlayers(q, limit = 50) {
  const needle = `%${String(q || "").toLowerCase().trim()}%`;
  return searchPlayersStmt.all({ q: needle, limit: Math.min(Number(limit) || 50, 200) })
    .map((r) => ({ ...r, teams: r.teams ? r.teams.split(",") : [] }));
}

// Matches on the team name OR on a roster member's Embark ID. "Which team was
// SHADOW on?" is the more common question than the team's exact name, and team
// names change between tournaments while the players mostly do not.
const searchTeamsStmt = db.prepare(`
  SELECT t.id, t.name, t.tournament_code,
         (SELECT COUNT(*) FROM match_teams mt WHERE mt.team_id = t.id) AS matches,
         (SELECT GROUP_CONCAT(p.embark_id, ', ')
            FROM team_members tm JOIN players p ON p.id = tm.player_id
           WHERE tm.team_id = t.id) AS roster
    FROM teams t
   WHERE (LOWER(t.name) LIKE @q
          OR EXISTS (SELECT 1
                       FROM team_members tm JOIN players p ON p.id = tm.player_id
                      WHERE tm.team_id = t.id AND LOWER(p.embark_id) LIKE @q))
     AND (@tournament IS NULL OR t.tournament_code = @tournament)
   ORDER BY matches DESC, t.name ASC
   LIMIT @limit
`);

function searchTeams(q, tournament, limit = 50) {
  return searchTeamsStmt.all({
    q: `%${String(q || "").toLowerCase().trim()}%`,
    tournament: tournament || null,
    limit: Math.min(Number(limit) || 50, 200),
  });
}

// --- profiles ---------------------------------------------------------------

const playerRowStmt = db.prepare(`SELECT id, embark_id, discord_username, first_seen_at, last_seen_at FROM players WHERE id = ?`);
const playerTeamsStmt = db.prepare(`
  SELECT t.id, t.name, t.tournament_code
    FROM team_members tm JOIN teams t ON t.id = tm.team_id
   WHERE tm.player_id = ?
   ORDER BY t.tournament_code DESC
`);
const playerMatchLogStmt = db.prepare(`
  SELECT vpm.match_id, vpm.tournament_code, vpm.pod_id, vpm.label, vpm.played_at, vpm.map,
         vpm.class, vpm.placement, vpm.team_cash, vpm.squad_label,
         vpm.eliminations, vpm.assists, vpm.deaths, vpm.revives,
         vpm.combat, vpm.support, vpm.objective, vpm.disconnected,
         t.name AS team_name
    FROM v_player_match vpm
    LEFT JOIN teams t ON t.id = vpm.team_id
   WHERE vpm.player_id = ?
   ORDER BY vpm.played_at DESC
   LIMIT 500
`);

function playerProfile(id) {
  const player = playerRowStmt.get(Number(id));
  if (!player) return null;
  const filters = { player_id: id };
  return {
    player,
    teams: playerTeamsStmt.all(Number(id)),
    totals: buildAggregate("player", filters, { limit: 1 })[0] || null,
    by_tournament: buildAggregate("tournament", filters, { sort: "matches", limit: 100 }),
    by_class: buildAggregate("class", filters, { sort: "matches", limit: 10 }),
    by_map: buildAggregate("map", filters, { sort: "matches", limit: 100 }),
    matches: playerMatchLogStmt.all(Number(id)),
  };
}

const teamRowStmt = db.prepare(`SELECT id, name, tournament_code FROM teams WHERE id = ?`);
const teamRosterStmt = db.prepare(`
  SELECT p.id, p.embark_id, p.discord_username, tm.is_sub
    FROM team_members tm JOIN players p ON p.id = tm.player_id
   WHERE tm.team_id = ?
   ORDER BY p.embark_id
`);
// One row per match this team played, with the squad's stat line for that
// match summed from its players. The LEFT JOIN keeps a match that was recorded
// with a placement but no readable player rows, rather than dropping it from
// the team's history.
const teamMatchesStmt = db.prepare(`
  SELECT m.id AS match_id, m.pod_id, m.label, m.played_at, m.tournament_code,
         COALESCE(m.map_observed, m.map_scheduled) AS map,
         mt.placement, mt.cash,
         COUNT(mp.id)                      AS players,
         SUM(mp.eliminations)              AS eliminations,
         SUM(mp.assists)                   AS assists,
         SUM(mp.deaths)                    AS deaths,
         SUM(mp.revives)                   AS revives,
         SUM(mp.combat)                    AS combat,
         SUM(mp.support)                   AS support,
         SUM(mp.objective)                 AS objective,
         SUM(COALESCE(mp.disconnected, 0)) AS disconnected
    FROM match_teams mt
    JOIN matches m ON m.id = mt.match_id
    LEFT JOIN match_players mp ON mp.match_team_id = mt.id
   WHERE mt.team_id = ?
   GROUP BY mt.id
   ORDER BY m.played_at DESC
`);

function teamProfile(id) {
  const team = teamRowStmt.get(Number(id));
  if (!team) return null;
  return {
    team,
    roster: teamRosterStmt.all(Number(id)),
    totals: buildAggregate("team", { team_id: id }, { limit: 1 })[0] || null,
    players: buildAggregate("player", { team_id: id }, { sort: "matches", limit: 50 }),
    // K/D is derived here rather than stored, same rule as everywhere else: a
    // moderator correcting one elimination has to move the ratio with it.
    matches: teamMatchesStmt.all(Number(id)).map((r) => ({
      ...r,
      kd: r.eliminations == null ? null
        : Number((r.deaths > 0 ? r.eliminations / r.deaths : r.eliminations).toFixed(2)),
    })),
  };
}

// --- matches ----------------------------------------------------------------

const matchByPodStmt = db.prepare(`SELECT * FROM matches WHERE tournament_code = ? AND pod_id = ?`);
const matchByIdStmt = db.prepare(`SELECT * FROM matches WHERE id = ?`);
const matchTeamsStmt = db.prepare(`
  SELECT mt.id, mt.team_id, mt.squad_label, mt.placement, mt.placement_observed, mt.cash, mt.slot,
         t.name AS team_name
    FROM match_teams mt LEFT JOIN teams t ON t.id = mt.team_id
   WHERE mt.match_id = ?
   ORDER BY CASE WHEN mt.placement IS NULL THEN 1 ELSE 0 END, mt.placement, mt.slot
`);
const matchPlayersStmt = db.prepare(`
  SELECT id, match_team_id, player_id, name_observed, class,
         eliminations, assists, deaths, revives, combat, support, objective, disconnected
    FROM match_players WHERE match_id = ?
   ORDER BY COALESCE(combat, 0) DESC
`);

// Shape used by both the web UI and the public bracket-site endpoint.
function matchDetail(match) {
  if (!match) return null;
  const teams = matchTeamsStmt.all(match.id);
  const players = matchPlayersStmt.all(match.id);
  const byTeam = new Map(teams.map((t) => [t.id, []]));
  for (const p of players) {
    const kd = p.deaths > 0 ? p.eliminations / p.deaths : p.eliminations;
    (byTeam.get(p.match_team_id) || []).push({
      ...p,
      kd: p.eliminations == null ? null : Number(kd.toFixed(2)),
      in_tournament: p.player_id != null,
    });
  }
  return {
    match: {
      id: match.id,
      tournament_code: match.tournament_code,
      pod_id: match.pod_id,
      label: match.label,
      map: match.map_observed || match.map_scheduled,
      map_scheduled: match.map_scheduled,
      map_observed: match.map_observed,
      on_stream: !!match.on_stream,
      played_at: match.played_at,
      confidence: match.confidence,
      notes: match.notes,
      submitted_by: match.submitted_by,
      applied_by: match.applied_by,
    },
    teams: teams.map((t) => ({
      id: t.id,
      team_id: t.team_id,
      name: t.team_name || t.squad_label || "Unknown squad",
      squad_label: t.squad_label,
      in_tournament: t.team_id != null,
      placement: t.placement,
      placement_observed: t.placement_observed,
      cash: t.cash,
      players: byTeam.get(t.id) || [],
    })),
  };
}

const getMatchByPod = (code, podId) => matchDetail(matchByPodStmt.get(code, podId));
const getMatchById = (id) => matchDetail(matchByIdStmt.get(Number(id)));

const listMatchesStmt = db.prepare(`
  SELECT m.id, m.tournament_code, m.pod_id, m.label, m.played_at,
         COALESCE(m.map_observed, m.map_scheduled) AS map, m.on_stream, m.confidence,
         (SELECT GROUP_CONCAT(COALESCE(t.name, mt.squad_label), ' | ')
            FROM match_teams mt LEFT JOIN teams t ON t.id = mt.team_id
           WHERE mt.match_id = m.id AND mt.placement IS NOT NULL
           ORDER BY mt.placement) AS teams
    FROM matches m
   WHERE (@tournament IS NULL OR m.tournament_code = @tournament)
   ORDER BY m.played_at DESC
   LIMIT @limit OFFSET @offset
`);

function listMatches({ tournament, limit = 100, offset = 0 } = {}) {
  return listMatchesStmt.all({
    tournament: tournament || null,
    limit: Math.min(Number(limit) || 100, 500),
    offset: Math.max(Number(offset) || 0, 0),
  });
}

const listTournamentsStmt = db.prepare(`
  SELECT tn.code, tn.name, tn.first_seen_at, tn.last_seen_at,
         (SELECT COUNT(*) FROM matches m WHERE m.tournament_code = tn.code) AS matches,
         (SELECT COUNT(*) FROM teams t WHERE t.tournament_code = tn.code)   AS teams
    FROM tournaments tn
   ORDER BY tn.last_seen_at DESC
`);
const listTournaments = () => listTournamentsStmt.all();

const listMapsStmt = db.prepare(`
  SELECT map, COUNT(*) AS matches FROM (
    SELECT COALESCE(map_observed, map_scheduled) AS map FROM matches
  ) WHERE map IS NOT NULL GROUP BY map ORDER BY matches DESC
`);
const listMaps = () => listMapsStmt.all();

// --- moderator corrections --------------------------------------------------

const EDITABLE = new Set(["class", "eliminations", "assists", "deaths", "revives", "combat", "support", "objective", "disconnected"]);
const getMatchPlayerStmt = db.prepare(`SELECT * FROM match_players WHERE id = ?`);
const insEditStmt = db.prepare(`
  INSERT INTO stat_edits (match_id, name_key, match_player_id, field, old_value, new_value, edited_by, edited_at)
  VALUES (@match_id, @name_key, @match_player_id, @field, @old_value, @new_value, @edited_by, @edited_at)
`);

/**
 * Correct one or more stat fields on a player's match row. Every change is
 * written to stat_edits with the old value, keyed by name_key as well as row
 * id so the history survives a re-ingest that replaces the row.
 */
function editMatchPlayer(id, changes, editedBy) {
  const row = getMatchPlayerStmt.get(Number(id));
  if (!row) return { error: "not found" };

  const fields = Object.keys(changes).filter((f) => EDITABLE.has(f));
  if (!fields.length) return { error: "no editable fields supplied" };

  const apply = db.transaction(() => {
    for (const field of fields) {
      const raw = changes[field];
      const next = field === "class"
        ? (raw == null ? null : String(raw).toUpperCase())
        : field === "disconnected"
          ? (raw ? 1 : 0)
          : (raw === null || raw === "" ? null : Number(raw));
      if (field !== "class" && field !== "disconnected" && next !== null && !Number.isFinite(next)) {
        throw new Error(`${field} must be a number`);
      }
      db.prepare(`UPDATE match_players SET ${field} = ? WHERE id = ?`).run(next, row.id);
      insEditStmt.run({
        match_id: row.match_id, name_key: row.name_key, match_player_id: row.id,
        field, old_value: row[field] == null ? null : String(row[field]),
        new_value: next == null ? null : String(next),
        edited_by: editedBy, edited_at: Date.now(),
      });
    }
    return getMatchPlayerStmt.get(row.id);
  });

  try { return { row: apply() }; }
  catch (e) { return { error: e.message }; }
}

const matchEditsStmt = db.prepare(`SELECT * FROM stat_edits WHERE match_id = ? ORDER BY edited_at DESC`);
const matchEdits = (matchId) => matchEditsStmt.all(Number(matchId));

// --- CSV --------------------------------------------------------------------

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

module.exports = {
  DIMENSIONS, SORTABLE,
  buildAggregate, searchPlayers, searchTeams,
  playerProfile, teamProfile,
  getMatchByPod, getMatchById, listMatches, listTournaments, listMaps,
  editMatchPlayer, matchEdits, toCsv,
};
