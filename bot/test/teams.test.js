// ============================================================================
// Team search and the per-team match log.
//
// The stat assertions deliberately do not hardcode numbers out of the fixture:
// they check that a team's match-log row agrees with the same match read
// through getMatchByPod. If those two ever disagree the site is showing one
// squad two different stat lines, which is worse than either being wrong.
//
//   node --test test/teams.test.js
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.CB_STATS_DB = process.env.CB_STATS_DB
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-teams-")), "test.db");

const { derivePlacements, podRosters } = require("../stats/rosters");
const { commitMatch } = require("../stats/ingest");
const Q = require("../web/queries");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cashout-01.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

// Same four-team pod the stats tests use, so the fixture rosters line up.
const STATE_4 = {
  name: "Test Cup",
  seeds: [
    { name: "Big Splash", players: ["SHADOW#7360", "NOUZEN#2675", "TEAALJ#0441"], discords: ["shadow", "nouzen", "teaalj"] },
    { name: "Live Wires", players: ["CRIMSON#6337", "COLGATE#0052", "JOEWOAHSEPH#8833"], discords: ["crimson", "colgate", "joe"] },
    { name: "Boundless", players: ["AYELEKZ#8224", "LUCKY#1444", "HONOURFUL#7117"], discords: ["ayelekz", "lucky", "honourful"] },
    { name: "Kingfish", players: ["AGENT_PENGUIN999#2110", "TSUNAMI4CHAN#5005", "CHICKENPOX#0211"], discords: ["penguin", "tsunami", "chicken"] },
  ],
  pods: [],
};
const POD_4 = {
  id: "groups-0", label: "Group A", map: "Skyway Stadium",
  teams: [{ name: "Big Splash" }, { name: "Live Wires" }, { name: "Boundless" }, { name: "Kingfish" }],
};

// One recorded match, committed once for the whole file.
const rosters = podRosters(STATE_4, POD_4);
const verdict = clone(FIXTURE);
const { placements, assignments } = derivePlacements(verdict.squads, rosters);
commitMatch({
  code: "CB-TEAMS", state: STATE_4, pod: POD_4, verdict, assignments, placements,
  appliedBy: "mod", submittedBy: "shadow", sha256: "teamtest", screenshotUrl: "http://x/y.png",
});

const findTeam = (name) => Q.searchTeams(name, null, 50).find((t) => t.name === name);

// --- search -----------------------------------------------------------------

test("a team is findable by name, including a partial one", () => {
  const hits = Q.searchTeams("splash", null, 50);
  assert.ok(hits.some((t) => t.name === "Big Splash"), "partial team name should match");

  const exact = Q.searchTeams("Kingfish", null, 50);
  assert.ok(exact.some((t) => t.name === "Kingfish"));
});

test("a team is findable by a player on it", () => {
  // The question people actually ask is "which team was SHADOW on?".
  const hits = Q.searchTeams("shadow", null, 50);
  const names = hits.map((t) => t.name);
  assert.ok(names.includes("Big Splash"), `searching a roster member should find their team, got ${JSON.stringify(names)}`);
});

test("search results carry the roster, so near-identical names are separable", () => {
  const team = findTeam("Live Wires");
  assert.ok(team, "Live Wires should be findable");
  assert.match(team.roster, /CRIMSON/i, "roster should list the team's players");
  assert.strictEqual(team.matches, 1, "and how many matches they have played");
});

test("searching something absent returns nothing rather than everything", () => {
  assert.deepStrictEqual(Q.searchTeams("zzzznotateam", null, 50), []);
});

test("the tournament filter still narrows a search", () => {
  assert.ok(Q.searchTeams("splash", "CB-TEAMS", 50).length > 0, "right tournament finds it");
  assert.deepStrictEqual(Q.searchTeams("splash", "CB-NOPE", 50), [], "wrong tournament excludes it");
});

// --- per-team match log -----------------------------------------------------

test("a team's match log carries that squad's stat line for each match", () => {
  const team = findTeam("Big Splash");
  const profile = Q.teamProfile(team.id);
  assert.strictEqual(profile.matches.length, 1);

  const row = profile.matches[0];
  assert.strictEqual(row.pod_id, "groups-0");
  assert.strictEqual(row.map, "Skyway Stadium");
  assert.strictEqual(row.players, 3, "a full squad played it");

  for (const k of ["eliminations", "assists", "deaths", "revives", "combat", "support", "objective"]) {
    assert.strictEqual(typeof row[k], "number", `${k} must be present on a match-log row`);
  }
});

test("the match log agrees with the match page for the same squad", () => {
  const team = findTeam("Big Splash");
  const row = Q.teamProfile(team.id).matches[0];

  const detail = Q.getMatchByPod("CB-TEAMS", "groups-0");
  const squad = detail.teams.find((t) => t.name === "Big Splash");
  assert.ok(squad, "the same squad must exist on the match page");

  const sum = (k) => squad.players.reduce((a, p) => a + (p[k] || 0), 0);
  for (const k of ["eliminations", "assists", "deaths", "revives", "combat", "support", "objective"]) {
    assert.strictEqual(row[k], sum(k), `${k} must match the sum of the squad's players`);
  }
  assert.strictEqual(row.placement, squad.placement, "and so must the placement");
  assert.strictEqual(row.cash, squad.cash);
});

test("K/D on a match row is derived from that match's sums", () => {
  const team = findTeam("Big Splash");
  const row = Q.teamProfile(team.id).matches[0];
  const expected = row.deaths > 0 ? row.eliminations / row.deaths : row.eliminations;
  assert.strictEqual(row.kd, Number(expected.toFixed(2)));
});

// --- match counting ---------------------------------------------------------
// v_player_match has one row per player per match. Counting those rows as
// "matches" made a team's totals read 3x high for a 3-player squad: one match
// showed as "3 matches, 3 won". These pin the count to match identity.

test("a team that has played one match reports one match, not one per player", () => {
  const team = findTeam("Big Splash");
  const totals = Q.buildAggregate("team", { team_id: team.id }, { limit: 1 })[0];
  assert.strictEqual(totals.matches, 1, "3 players in 1 match is still 1 match");
});

test("the totals tile and the match log cannot disagree about match count", () => {
  // The invariant the bug broke: the number on the team page has to be the
  // number of rows underneath it.
  for (const name of ["Big Splash", "Live Wires", "Boundless", "Kingfish"]) {
    const team = findTeam(name);
    const profile = Q.teamProfile(team.id);
    assert.strictEqual(profile.totals.matches, profile.matches.length,
      `${name}: totals say ${profile.totals.matches} matches, log has ${profile.matches.length}`);
  }
});

test("wins are counted per match, not per player on the winning squad", () => {
  const winner = findTeam("Live Wires");   // placed 1st in the fixture
  const wt = Q.buildAggregate("team", { team_id: winner.id }, { limit: 1 })[0];
  assert.strictEqual(wt.wins, 1, "one won match, not one per player");
  assert.strictEqual(wt.win_rate, 100);

  const loser = findTeam("Big Splash");    // placed 2nd
  const lt = Q.buildAggregate("team", { team_id: loser.id }, { limit: 1 })[0];
  assert.strictEqual(lt.wins, 0);
  assert.strictEqual(lt.win_rate, 0);
});

test("per-match averages divide by matches, not by player rows", () => {
  const team = findTeam("Big Splash");
  const totals = Q.buildAggregate("team", { team_id: team.id }, { limit: 1 })[0];
  const row = Q.teamProfile(team.id).matches[0];

  // One match played, so the squad's per-match figures are that match's totals.
  assert.strictEqual(totals.elims_per_match, row.eliminations);
  assert.strictEqual(totals.combat_per_match, row.combat);
  assert.strictEqual(totals.objective_per_match, row.objective);
});

test("counting by match identity leaves the player dimension alone", () => {
  // A player has exactly one row per match, so this was always right and must
  // stay right.
  const rows = Q.buildAggregate("player", {}, { limit: 50 });
  assert.ok(rows.length >= 12, "all twelve players should aggregate");
  for (const r of rows) {
    assert.strictEqual(r.matches, 1, `${r.label} played one match`);
  }
});

test("every team in the pod gets its own distinct match row", () => {
  const seen = new Map();
  for (const name of ["Big Splash", "Live Wires", "Boundless", "Kingfish"]) {
    const team = findTeam(name);
    const rows = Q.teamProfile(team.id).matches;
    assert.strictEqual(rows.length, 1, `${name} should have exactly one match`);
    seen.set(name, rows[0]);
  }
  // The winner and the last-placed squad must not be showing the same numbers.
  const placements = [...seen.values()].map((r) => r.placement).sort();
  assert.deepStrictEqual(placements, [1, 2, 3, 4], "placements should be distinct across the pod");
});
