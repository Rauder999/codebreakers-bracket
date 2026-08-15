// ============================================================================
// Fill a scratch database with plausible tournament data so the web UI can be
// developed and reviewed without waiting for a real tournament.
//
//   CB_STATS_DB=/tmp/cb-dev.db node test/seed-dev.js
//
// It also mints a signed-in session and prints the cookie, so you can open the
// site without configuring Discord OAuth on a dev box. This writes ONLY to the
// database named by CB_STATS_DB -- never point it at the production file.
// ============================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (!process.env.CB_STATS_DB) {
  console.error("refusing to run without an explicit CB_STATS_DB (do not seed production)");
  process.exit(1);
}

const { db, now } = require("../stats/db");
const { derivePlacements, podRosters } = require("../stats/rosters");
const { commitMatch } = require("../stats/ingest");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cashout-01.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

const TEAMS = [
  { name: "Big Splash", players: ["SHADOW#7360", "NOUZEN#2675", "TEAALJ#0441"], discords: ["shadow", "nouzen", "teaalj"] },
  { name: "Live Wires", players: ["CRIMSON#6337", "COLGATE#0052", "JOEWOAHSEPH#8833"], discords: ["crimson", "colgate", "joe"] },
  { name: "Boundless", players: ["AYELEKZ#8224", "LUCKY#1444", "HONOURFUL#7117"], discords: ["ayelekz", "lucky", "honourful"] },
  { name: "Kingfish", players: ["AGENT_PENGUIN999#2110", "TSUNAMI4CHAN#5005", "CHICKENPOX#0211"], discords: ["penguin", "tsunami", "chicken"] },
];
const MAPS = ["Skyway Stadium", "Monaco", "Las Vegas 2032", "Seoul", "Kyoto 1568"];

// Deterministic jitter so re-seeding gives the same numbers.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const jitter = (v, spread) => Math.max(0, Math.round(Number(String(v).replace(/[^0-9]/g, "")) * (1 - spread + rnd() * spread * 2)));

function makeVerdict(order, map) {
  const base = clone(FIXTURE);
  const bySquad = new Map(base.squads.map((s) => [s.squad_label, s]));
  const labels = ["THE BIG SPLASH", "THE LIVE WIRES", "THE BOUNDLESS", "THE KINGFISH"];
  return {
    ...base,
    map_name: map,
    squads: order.map((teamIndex, i) => {
      const s = clone(bySquad.get(labels[teamIndex]));
      s.placement = i + 1;
      s.cash = "$" + (40000 - i * 7000).toLocaleString();
      s.players = s.players.map((p) => ({
        ...p,
        eliminations: String(jitter(p.eliminations, 0.6)),
        assists: String(jitter(p.assists, 0.6)),
        deaths: String(jitter(p.deaths, 0.5)),
        revives: String(jitter(p.revives, 0.9)),
        combat: String(jitter(p.combat, 0.35)),
        support: String(jitter(p.support, 0.5)),
        objective: String(jitter(p.objective, 0.4)),
      }));
      return s;
    }),
  };
}

const ORDERS = [[1, 0, 2, 3], [0, 2, 1, 3], [2, 3, 0, 1], [1, 3, 2, 0], [3, 1, 0, 2], [0, 1, 3, 2]];

function seedTournament(code, name, matchCount) {
  const state = { name, seeds: TEAMS, pods: [] };
  let made = 0;
  for (let i = 0; i < matchCount; i++) {
    const pod = {
      id: `pod-${i}`,
      label: i === matchCount - 1 ? "Grand Final" : `Group match ${i + 1}`,
      map: MAPS[i % MAPS.length],
      onStream: i === matchCount - 1,
      teams: TEAMS.map((t) => ({ name: t.name })),
    };
    const verdict = makeVerdict(ORDERS[i % ORDERS.length], pod.map);
    const rosters = podRosters(state, pod);
    const { placements, assignments } = derivePlacements(verdict.squads, rosters);
    if (!placements) { console.error(`  skipped ${pod.id}: could not derive placements`); continue; }
    commitMatch({
      code, state, pod, verdict, assignments, placements,
      appliedBy: "seed-mod", submittedBy: "shadow",
      sha256: crypto.randomBytes(8).toString("hex"), screenshotUrl: "",
    });
    // Spread the matches out over the past fortnight so date ordering reads sensibly.
    db.prepare(`UPDATE matches SET played_at = ? WHERE tournament_code = ? AND pod_id = ?`)
      .run(now() - (matchCount - i) * 36e5 * 6, code, pod.id);
    made++;
  }
  console.log(`seeded ${code} (${name}): ${made} matches`);
}

seedTournament("CB-DEV1", "Winter Open", 6);
seedTournament("CB-DEV2", "Spring Invitational", 4);

// A signed-in session, so the UI is reviewable without OAuth.
//
// Borrow the first configured admin id rather than inventing one: admin is
// resolved from config.stats.adminDiscordIds on every request, so a made-up id
// would log in as a plain viewer and the moderator tools would stay invisible.
const cfgPath = path.join(__dirname, "..", "config.json");
const adminIds = (JSON.parse(fs.readFileSync(cfgPath, "utf8")).stats || {}).adminDiscordIds || [];
const devId = adminIds[0] || "1";

const ts = now();
db.prepare(`
  INSERT INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
  VALUES (?, 'devmod', 'Dev Moderator', NULL, 'admin', ?, ?)
  ON CONFLICT(discord_id) DO UPDATE SET role = 'admin', last_login_at = excluded.last_login_at
`).run(devId, ts, ts);
const sid = "dev" + crypto.randomBytes(24).toString("hex");
db.prepare(`INSERT INTO sessions (id, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
  .run(sid, devId, ts, ts + 7 * 24 * 3600 * 1000);

console.log(`\ndatabase: ${process.env.CB_STATS_DB}`);
console.log(`dev session cookie:\n  document.cookie = "cbstats_sid=${sid}; path=/"`);
