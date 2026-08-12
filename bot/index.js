// ============================================================================
// CodeBreakers Discord bot \u2014 v1
//   \u2022 Match-ready pings: watches live bracket sessions over WebSocket and
//     pings team members when their next match is formed.
//   \u2022 Moderator management from Discord (/mod add|remove|list, see mods.js).
//   \u2022 Tournament role sync (one-shot CLI):
//       node index.js sync-roles CB-XXXX ["Role Name"]
// Config: config.json (worker URL, announce channel). Token: .env next to it.
// ============================================================================
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { Client, GatewayIntentBits } = require("discord.js");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const envText = fs.existsSync(path.join(__dirname, ".env")) ? fs.readFileSync(path.join(__dirname, ".env"), "utf8") : "";
const ENV = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const TOKEN = ENV.DISCORD_BOT_TOKEN;
if (!TOKEN) { console.error("DISCORD_BOT_TOKEN is missing in /opt/cb-bot/.env"); process.exit(1); }

const WORKER = CFG.workerUrl;
const WSBASE = WORKER.replace(/^http/, "ws");

// Announced pods survive restarts so we never double-ping.
const STATE_FILE = path.join(__dirname, "state.json");
let persisted = { announced: {} };
try { persisted = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ }
const savePersisted = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(persisted)); } catch (e) { console.error("state save failed:", e.message); } };

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Same normalization as the bracket worker: lowercase, no @, no #discriminator.
const norm = (s) => String(s || "").toLowerCase().trim().replace(/^@/, "").split("#")[0];
// Roster discords sometimes arrive as one comma-joined string (CSV cell with
// the whole team in it) - always expand before matching.
const splitDiscords = (arr) => (arr || []).flatMap((d) => String(d).split(",")).map((d) => d.trim()).filter(Boolean);

async function mainGuild() {
  const g = client.guilds.cache.first();
  if (!g) return null;
  try { await g.members.fetch(); } catch (e) { console.error("members fetch failed (Server Members Intent enabled?):", e.message); }
  return g;
}
function findMember(g, discordName) {
  const n = norm(discordName);
  return g.members.cache.find((m) => m.user.username.toLowerCase() === n) || null;
}

// \u2500\u2500\u2500 Match-ready watcher \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const sessions = new Map(); // code -> { ws, seen }

async function pollSessions() {
  try {
    const res = await fetch(`${WORKER}/sessions/active`);
    const data = await res.json();
    const activeCodes = new Set((data.sessions || []).map((s) => s.code));
    for (const code of activeCodes) if (!sessions.has(code)) watchSession(code);
    for (const [code, s] of sessions) if (!activeCodes.has(code)) { try { s.ws && s.ws.close(); } catch {} sessions.delete(code); }
  } catch (e) { console.error("sessions poll failed:", e.message); }
}

function watchSession(code) {
  const entry = { ws: null, seen: false };
  sessions.set(code, entry);
  const connect = () => {
    if (!sessions.has(code)) return;
    let ws;
    try { ws = new WebSocket(`${WSBASE}/session/${code}/ws`); } catch { setTimeout(connect, 5000); return; }
    entry.ws = ws;
    ws.on("message", (buf) => {
      let data; try { data = JSON.parse(buf.toString()); } catch { return; }
      if (data.t === "state" && typeof data.state === "string") onState(code, entry, data.state).catch((e) => console.error("onState:", e.message));
    });
    ws.on("close", () => { if (sessions.has(code)) setTimeout(connect, 5000); });
    ws.on("error", () => { try { ws.close(); } catch {} });
  };
  connect();
  console.log(`watching session ${code}`);
}

// A pod is "ready" when every slot is filled and nothing is decided yet.
const podReady = (p) => p.teams && p.teams.length >= 2 && p.teams.every((t) => t.name) && p.teams.every((t) => !t.placement);

async function onState(code, entry, stateStr) {
  let s; try { s = JSON.parse(stateStr); } catch { return; }
  if (!Array.isArray(s.pods)) return;
  entry.lastState = s; // results.js matches screenshot authors against this
  if (!persisted.announced[code]) persisted.announced[code] = [];
  const ann = new Set(persisted.announced[code]);

  // The host controls the starting gun: until the admin panel sets
  // tournamentStarted, the bot neither pings nor opens threads. The moment it
  // flips true, every ready pod (round 1 included) gets announced exactly once.
  if (!s.tournamentStarted) return;

  for (const pod of s.pods) {
    if (!podReady(pod) || ann.has(pod.id)) continue;
    ann.add(pod.id);
    persisted.announced[code] = [...ann];
    savePersisted();
    await announce(code, s, pod);
  }

  // Mid-tournament roster fixes: let matches.js refresh thread rosters and
  // quietly add players whose discords were just corrected by the admin.
  if (matchesApi && matchesApi.onStateUpdate) {
    try { await matchesApi.onStateUpdate(code, s); }
    catch (e) { console.error("matches roster sync:", e.message); }
  }
}

async function announce(code, s, pod) {
  const g = await mainGuild();
  // Private setup thread first, so the announcement can link to it.
  let thread = null;
  if (matchesApi) {
    try { thread = await matchesApi.onMatchReady(code, s, pod); }
    catch (e) { console.error("matches: thread creation failed:", e.message); }
  }
  const byTeam = new Map((s.seeds || []).map((sd) => [sd.name, sd.discords || []]));
  const names = pod.teams.map((t) => t.name);
  const mentions = [];
  for (const teamName of names) {
    for (const d of splitDiscords(byTeam.get(teamName))) {
      const m = g ? findMember(g, d) : null;
      mentions.push(m ? `<@${m.id}>` : `@${norm(d)}`);
    }
  }
  // Unicode is written as escapes on purpose: the file travels to the VM
  // through pipes that have mangled raw UTF-8 before.
  const SWORDS = "\u2694\uFE0F", CAMERA = "\uD83C\uDFA5", DASH = "\u2014";
  const vs = names.map((n) => `**${n}**`).join("  vs  ");
  const streamed = pod.onStream || pod.liveNow;
  const embed = {
    title: streamed ? `${CAMERA}  ${pod.label} ${DASH} STREAMED MATCH` : `${SWORDS}  ${pod.label} is ready`,
    description: [
      vs,
      "",
      streamed
        ? `This match will be **streamed** ${DASH} wait for the observer to send the lobby code.`
        : `Your match is **not** on stream ${DASH} please play it as soon as possible.`,
      thread ? `Setup, map bans and result submission: <#${thread.id}>` : null,
    ].filter(Boolean).join("\n"),
    color: streamed ? 0xff4d5e : 0x7c5cff,
    footer: { text: "CODEBREAKERS \u00B7 live bracket" },
    timestamp: new Date().toISOString(),
  };

  console.log(`[${code}] announce ${pod.id}: ${names.join(" vs ")} (${mentions.length} mentions)`);
  const channelId = (matchesApi && matchesApi.channelFor) ? matchesApi.channelFor(code) : CFG.announceChannelId;
  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId);
      await ch.send({ content: mentions.join(" "), embeds: [embed] });
    } catch (e) { console.error("announce send failed:", e.message); }
  }
}

// \u2500\u2500\u2500 One-shot role sync: node index.js sync-roles CB-XXXX ["Role Name"] \u2500\u2500\u2500\u2500\u2500
async function syncRoles(code, roleName) {
  const res = await fetch(`${WORKER}/session/${code}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`session ${code}: ${data.error || "not found"}`);
  const s = JSON.parse(data.state);
  const g = await mainGuild();
  if (!g) throw new Error("bot is not in any guild \u2014 invite it first");
  const name = roleName || `Tournament: ${data.name || code}`;
  let role = g.roles.cache.find((r) => r.name === name);
  if (!role) role = await g.roles.create({ name, mentionable: true, reason: `CodeBreakers ${code}` });
  let added = 0; const missing = [];
  for (const seed of s.seeds || []) {
    for (const d of splitDiscords(seed.discords)) {
      const m = findMember(g, d);
      if (!m) { missing.push(`${seed.name}: ${d}`); continue; }
      if (!m.roles.cache.has(role.id)) { await m.roles.add(role); added++; }
    }
  }
  console.log(`role "${name}": +${added} members`);
  if (missing.length) console.log("not found on server:\n  " + missing.join("\n  "));
  return { name, added, missing };
}

// \u2500\u2500\u2500 Modules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// mods: /mod moderator management, asked "who is a moderator?" by the other
// two. results: vision + moderator confirmation + stats. matches: per-match
// private threads, map bans, and the only paths that may submit a screenshot.
const [, , cmd, arg1, arg2] = process.argv;
let modsApi = null, resultsApi = null, matchesApi = null;
try {
  modsApi = require("./mods")({ client, CFG, cliMode: !!cmd });
} catch (e) { console.error("mods module failed to load:", e.message); }
try {
  resultsApi = require("./results")({ client, sessions, CFG, ENV, WORKER, norm, mainGuild, mods: modsApi });
} catch (e) { console.error("results module failed to load:", e.message); }
try {
  matchesApi = require("./matches")({ client, sessions, CFG, ENV, WORKER, norm, mainGuild, findMember, results: resultsApi, syncRoles, mods: modsApi });
} catch (e) { console.error("matches module failed to load:", e.message); }

// \u2500\u2500\u2500 Entrypoint \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
client.once("clientReady", async () => {
  console.log(`logged in as ${client.user.tag}; guilds: ${[...client.guilds.cache.values()].map((g) => g.name).join(", ") || "none"}`);
  if (matchesApi && cmd !== "sync-roles") {
    try { await matchesApi.registerCommands(); } catch (e) { console.error("command registration failed:", e.message); }
  }
  if (cmd === "sync-roles") {
    try { await syncRoles(String(arg1 || "").toUpperCase(), arg2); } catch (e) { console.error("sync-roles failed:", e.message); process.exitCode = 1; }
    client.destroy();
    return;
  }
  pollSessions();
  setInterval(pollSessions, (CFG.pollIntervalSec || 60) * 1000);
});
client.login(TOKEN);
