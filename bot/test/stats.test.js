// ============================================================================
// Offline tests for the stats pipeline. No Discord, no Anthropic, no network:
// the vision output is a hand-transcribed fixture of a real scoreboard
// (test/fixtures/cashout-01.json), so these tests pin the parts that actually
// go wrong -- placement order, roster matching, Embark ID collisions and the
// arithmetic behind every average.
//
//   CB_STATS_DB=/tmp/cb-test.db node --test test/
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Give every run its own database file before anything opens one.
process.env.CB_STATS_DB = process.env.CB_STATS_DB
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-stats-")), "test.db");

const { db, embarkKey, baseKey, toInt } = require("../stats/db");
const { derivePlacements, podRosters } = require("../stats/rosters");
const { commitMatch } = require("../stats/ingest");
const Q = require("../web/queries");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cashout-01.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

// A four-team group pod whose rosters match the fixture exactly.
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

test("normalizers keep the #tag that makes an Embark ID unique", () => {
  assert.notStrictEqual(embarkKey("SHADOW#7360"), embarkKey("SHADOW#1111"));
  assert.strictEqual(embarkKey("  [ASBRU] Shadow#7360 "), "shadow#7360");
  assert.strictEqual(baseKey("SHADOW#7360"), "shadow");
});

test("toInt strips the formatting the scoreboard uses", () => {
  assert.strictEqual(toInt("3,270"), 3270);
  assert.strictEqual(toInt("$39,500"), 39500);
  assert.strictEqual(toInt("0"), 0);
  assert.strictEqual(toInt(""), null);
  assert.strictEqual(toInt(null), null);
});

test("placement comes from the badge, not the order squads appear in", () => {
  const rosters = podRosters(STATE_4, POD_4);
  const { placements, problems } = derivePlacements(clone(FIXTURE).squads, rosters);

  // THE BIG SPLASH is listed FIRST on screen but placed 2nd.
  assert.deepStrictEqual(placements, {
    "Live Wires": 1, "Big Splash": 2, "Boundless": 3, "Kingfish": 4,
  });
  assert.deepStrictEqual(problems, []);
});

test("a two-team match inside a four-squad lobby collapses to 1-2", () => {
  // Only Boundless (badge 3) and Kingfish (badge 4) are in this bracket match.
  const state = { ...STATE_4 };
  const pod = { id: "final-0", label: "Final", teams: [{ name: "Boundless" }, { name: "Kingfish" }] };
  const rosters = podRosters(state, pod);
  const { placements, assignments } = derivePlacements(clone(FIXTURE).squads, rosters);

  assert.deepStrictEqual(placements, { Boundless: 1, Kingfish: 2 });
  // The other two squads are still reported, just unassigned.
  assert.strictEqual(assignments.filter((a) => !a.team).length, 2);
});

test("a squad nobody on the roster appears in is not matched", () => {
  const squads = clone(FIXTURE).squads;
  squads[0].players = [{ name: "RANDO#0001" }, { name: "RANDO#0002" }, { name: "RANDO#0003" }];
  const rosters = podRosters(STATE_4, POD_4);
  const { placements, problems } = derivePlacements(squads, rosters);

  assert.strictEqual(placements, null, "must refuse to guess a result");
  assert.match(problems.join(" "), /Big Splash/);
});

test("ambiguous untagged roster names do not silently merge two players", () => {
  const state = {
    name: "Ambiguous Cup",
    seeds: [
      // Written without tags, and both are "shadow".
      { name: "Twins", players: ["SHADOW", "SHADOW"], discords: ["a", "b"] },
      { name: "Live Wires", players: ["CRIMSON#6337", "COLGATE#0052", "JOEWOAHSEPH#8833"], discords: ["c", "d", "e"] },
    ],
    pods: [],
  };
  const pod = { id: "p", label: "P", teams: [{ name: "Twins" }, { name: "Live Wires" }] };
  const { placements } = derivePlacements(clone(FIXTURE).squads, podRosters(state, pod));

  // "Twins" cannot be identified from an ambiguous base name, so no result.
  assert.strictEqual(placements, null);
});

test("commitMatch stores every stat column for every player", () => {
  const rosters = podRosters(STATE_4, POD_4);
  const verdict = clone(FIXTURE);
  const { placements, assignments } = derivePlacements(verdict.squads, rosters);

  const out = commitMatch({
    code: "CB-TEST", state: STATE_4, pod: POD_4, verdict, assignments, placements,
    appliedBy: "mod", submittedBy: "shadow", sha256: "deadbeef", screenshotUrl: "http://x/y.png",
  });
  assert.strictEqual(out.teams, 4);
  assert.strictEqual(out.players, 12);

  const detail = Q.getMatchByPod("CB-TEST", "groups-0");
  assert.strictEqual(detail.teams.length, 4);
  assert.strictEqual(detail.teams[0].name, "Live Wires");
  assert.strictEqual(detail.teams[0].placement, 1);
  assert.strictEqual(detail.teams[0].cash, 40000);
  assert.strictEqual(detail.teams[1].placement_observed, 2);

  const honourful = detail.teams
    .flatMap((t) => t.players)
    .find((p) => p.name_observed === "HONOURFUL#7117");
  assert.strictEqual(honourful.class, "H");
  assert.strictEqual(honourful.eliminations, 10);
  assert.strictEqual(honourful.assists, 2);
  assert.strictEqual(honourful.deaths, 4);
  assert.strictEqual(honourful.revives, 1);
  assert.strictEqual(honourful.combat, 5726);
  assert.strictEqual(honourful.support, 556);
  assert.strictEqual(honourful.objective, 2700);
  assert.strictEqual(honourful.kd, 2.5);
  assert.strictEqual(honourful.in_tournament, true);
});

test("re-ingesting the same pod corrects rather than duplicates", () => {
  const rosters = podRosters(STATE_4, POD_4);
  const verdict = clone(FIXTURE);
  verdict.squads[0].players[0].eliminations = "30";   // corrected screenshot
  const { placements, assignments } = derivePlacements(verdict.squads, rosters);

  const out = commitMatch({
    code: "CB-TEST", state: STATE_4, pod: POD_4, verdict, assignments, placements,
    appliedBy: "mod2", submittedBy: "shadow", sha256: "cafe", screenshotUrl: "http://x/z.png",
  });
  assert.strictEqual(out.players, 12, "still 12 rows, not 24");

  const detail = Q.getMatchByPod("CB-TEST", "groups-0");
  const shadow = detail.teams.flatMap((t) => t.players).find((p) => p.name_observed === "SHADOW#7360");
  assert.strictEqual(shadow.eliminations, 30);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM match_players").get().c, 12);
});

test("aggregates derive K/D and per-match averages from sums", () => {
  const player = Q.searchPlayers("honourful")[0];
  assert.ok(player, "player should be searchable by Embark ID");

  const profile = Q.playerProfile(player.id);
  assert.strictEqual(profile.totals.matches, 1);
  assert.strictEqual(profile.totals.eliminations, 10);
  assert.strictEqual(profile.totals.deaths, 4);
  assert.strictEqual(profile.totals.kd, 2.5);
  assert.strictEqual(profile.totals.objective_per_match, 2700);
  assert.strictEqual(profile.by_class[0].label, "H");

  // Grouping by class must split the same match across its L/M/H rows.
  const byClass = Q.buildAggregate("class", { tournament: "CB-TEST" }, { sort: "matches" });
  const heavy = byClass.find((r) => r.key === "H");
  const medium = byClass.find((r) => r.key === "M");
  assert.strictEqual(heavy.matches + medium.matches, 12);
});

test("zero deaths falls back to raw eliminations instead of dividing by zero", () => {
  const state = {
    name: "Flawless Cup",
    seeds: [
      { name: "Perfect", players: ["FLAWLESS#0001"], discords: ["f"] },
      { name: "Victims", players: ["VICTIM#0002"], discords: ["v"] },
    ],
    pods: [],
  };
  const pod = { id: "p1", label: "Flawless", teams: [{ name: "Perfect" }, { name: "Victims" }] };
  const verdict = {
    screen_type: "final_round_results", confidence: "high", map_name: "Monaco", in_progress: false, notes: "",
    squads: [
      { placement: 1, squad_label: "Perfect", cash: "$50,000", players: [{ name: "FLAWLESS#0001", class: "L", eliminations: "9", assists: "0", deaths: "0", revives: "0", combat: "9,000", support: "0", objective: "0" }] },
      { placement: 2, squad_label: "Victims", cash: "$10,000", players: [{ name: "VICTIM#0002", class: "H", eliminations: "0", assists: "0", deaths: "9", revives: "0", combat: "0", support: "0", objective: "0" }] },
    ],
  };
  const rosters = podRosters(state, pod);
  const { placements, assignments } = derivePlacements(verdict.squads, rosters);
  commitMatch({ code: "CB-FLAW", state, pod, verdict, assignments, placements, appliedBy: "mod", submittedBy: "f", sha256: "f1", screenshotUrl: "" });

  const flawless = Q.playerProfile(Q.searchPlayers("flawless")[0].id);
  assert.strictEqual(flawless.totals.kd, 9, "0 deaths is a real result, not a divide-by-zero");
  const victim = Q.playerProfile(Q.searchPlayers("victim")[0].id);
  assert.strictEqual(victim.totals.kd, 0);
});

test("moderator edits are applied and audited, and averages follow", () => {
  const detail = Q.getMatchByPod("CB-TEST", "groups-0");
  const row = detail.teams.flatMap((t) => t.players).find((p) => p.name_observed === "CHICKENPOX#0211");
  assert.strictEqual(row.eliminations, 1);

  const out = Q.editMatchPlayer(row.id, { eliminations: 4 }, "mod-tester");
  assert.ok(!out.error, out.error);
  assert.strictEqual(out.row.eliminations, 4);

  const edits = Q.matchEdits(detail.match.id);
  assert.strictEqual(edits[0].field, "eliminations");
  assert.strictEqual(edits[0].old_value, "1");
  assert.strictEqual(edits[0].new_value, "4");
  assert.strictEqual(edits[0].edited_by, "mod-tester");

  const chicken = Q.playerProfile(Q.searchPlayers("chickenpox")[0].id);
  assert.strictEqual(chicken.totals.eliminations, 4, "the average must follow the correction");
});

test("rejects an unknown group_by instead of building SQL from it", () => {
  assert.throws(() => Q.buildAggregate("players; DROP TABLE matches", {}, {}), /unknown group_by/);
});
