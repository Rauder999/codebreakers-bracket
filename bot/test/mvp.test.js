// ============================================================================
// Tournament MVP scoring.
//
// scoreMvp is pure, so these feed it hand-built rows instead of depending on
// what the fixture happens to contain. That matters here: the award is a
// judgement encoded as arithmetic, and the things worth pinning are the
// judgements -- that fragging is weighted heaviest, that placement counts for
// nothing, and that one lucky game cannot win it.
//
//   node --test test/mvp.test.js
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.CB_STATS_DB = process.env.CB_STATS_DB
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-mvp-")), "test.db");

const Q = require("../web/queries");

// A player row shaped like buildAggregate("player", ...) returns.
const p = (label, over = {}) => ({
  key: label, label, matches: 4,
  combat_per_match: 3000, kd: 1.0, support_per_match: 500, objective_per_match: 2000,
  assists_per_match: 4, eliminations: 40, deaths: 40, combat: 12000,
  ...over,
});

test("the best in each metric scores 100% for that part", () => {
  const out = Q.scoreMvp([
    p("Fragger", { combat_per_match: 6000, kd: 2.0 }),
    p("Anchor", { support_per_match: 1500, objective_per_match: 5000 }),
  ]);
  const fragger = out.leaders.find((r) => r.label === "Fragger");
  const anchor = out.leaders.find((r) => r.label === "Anchor");

  assert.strictEqual(fragger.parts.combat_per_match, 100, "top combat is the 100% mark");
  assert.strictEqual(fragger.parts.kd, 100);
  assert.strictEqual(anchor.parts.support_per_match, 100);
  assert.strictEqual(anchor.parts.objective_per_match, 100);
  // And being half the best reads as half.
  assert.strictEqual(anchor.parts.combat_per_match, 50);
});

test("fragging outweighs support and objective, as chosen", () => {
  // Identical players except one fragged and one played the objective. With
  // combat+K/D at 70% of the award the fragger has to come out ahead.
  const out = Q.scoreMvp([
    p("Fragger", { combat_per_match: 6000, kd: 2.0, support_per_match: 200, objective_per_match: 500 }),
    p("Objective", { combat_per_match: 2000, kd: 0.7, support_per_match: 1500, objective_per_match: 5000 }),
  ]);
  assert.strictEqual(out.leaders[0].label, "Fragger");
});

test("a support player still beats a mediocre fragger", () => {
  // The 30% has to be worth something, or those metrics are decoration.
  const out = Q.scoreMvp([
    p("Mediocre", { combat_per_match: 2600, kd: 0.9, support_per_match: 100, objective_per_match: 200 }),
    p("Support", { combat_per_match: 2400, kd: 0.85, support_per_match: 3000, objective_per_match: 4000 }),
  ]);
  assert.strictEqual(out.leaders[0].label, "Support");
});

test("placement is not part of the score", () => {
  // The Valorant case: knocked out early, but the numbers were the best in
  // the tournament. Identical rows apart from results that MVP must ignore.
  const out = Q.scoreMvp([
    p("Champion", { combat_per_match: 3000, wins: 6, avg_placement: 1 }),
    p("EliminatedEarly", { combat_per_match: 6000, kd: 2.0, wins: 0, avg_placement: 3.5 }),
  ]);
  assert.strictEqual(out.leaders[0].label, "EliminatedEarly",
    "winning the bracket must not buy the MVP award");
});

test("one big game does not win it: half the deepest run is the floor", () => {
  const out = Q.scoreMvp([
    p("Regular", { matches: 6, combat_per_match: 3000 }),
    p("Regular2", { matches: 5, combat_per_match: 2800 }),
    p("OneHitWonder", { matches: 1, combat_per_match: 99999, kd: 12 }),
  ]);
  assert.strictEqual(out.max_matches, 6);
  assert.strictEqual(out.min_matches, 3, "half of six, rounded up");
  assert.strictEqual(out.qualified, 2);
  assert.ok(!out.leaders.some((r) => r.label === "OneHitWonder"), "one game cannot qualify");
  assert.strictEqual(out.leaders[0].label, "Regular");
});

test("a non-qualifier cannot set the bar the others are measured against", () => {
  // If the excluded player's huge game defined 100%, everyone real would be
  // scored against a number nobody could reach.
  const out = Q.scoreMvp([
    p("A", { matches: 4, combat_per_match: 3000 }),
    p("B", { matches: 4, combat_per_match: 1500 }),
    p("Ghost", { matches: 1, combat_per_match: 60000 }),
  ]);
  const a = out.leaders.find((r) => r.label === "A");
  assert.strictEqual(a.parts.combat_per_match, 100, "the best QUALIFIED player is the 100% mark");
});

test("everyone qualifies when nobody played more than one match", () => {
  const out = Q.scoreMvp([p("A", { matches: 1 }), p("B", { matches: 1 })]);
  assert.strictEqual(out.min_matches, 1);
  assert.strictEqual(out.qualified, 2);
});

test("a metric nobody scored in is dropped rather than dragging every score", () => {
  // No objective recorded all tournament. Its 15% is shared out, so the top
  // player still reaches 100 rather than being capped at 85.
  const out = Q.scoreMvp([
    p("Top", { combat_per_match: 5000, kd: 2, support_per_match: 900, objective_per_match: 0 }),
    p("Other", { combat_per_match: 2500, kd: 1, support_per_match: 450, objective_per_match: 0 }),
  ]);
  assert.ok(!out.metrics_used.includes("objective_per_match"), "an all-zero metric is not scored");
  assert.strictEqual(out.leaders[0].score, 100, "the best in every live metric scores 100");
});

test("an empty field is reported, not crashed on", () => {
  const out = Q.scoreMvp([]);
  assert.deepStrictEqual(out.leaders, []);
  assert.strictEqual(out.qualified, 0);
  assert.strictEqual(out.min_matches, 0);
});

test("the leaderboard is capped and ordered by score", () => {
  const rows = Array.from({ length: 25 }, (_, i) => p(`P${i}`, { combat_per_match: 1000 + i * 100 }));
  const out = Q.scoreMvp(rows, { limit: 5 });
  assert.strictEqual(out.leaders.length, 5);
  assert.strictEqual(out.leaders[0].label, "P24", "highest score first");
  for (let i = 1; i < out.leaders.length; i++) {
    assert.ok(out.leaders[i - 1].score >= out.leaders[i].score, "scores must descend");
  }
});
