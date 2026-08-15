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
