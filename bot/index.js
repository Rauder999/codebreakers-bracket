// ============================================================================
// CodeBreakers Discord bot — v1
//   • Match-ready pings: watches live bracket sessions over WebSocket and
//     pings team members when their next match is formed.
//   • Tournament role sync (one-shot CLI):
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

// ─── Match-ready watcher ────────────────────────────────────────────────────
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

  // First snapshot of a session: swallow everything silently. Round 1 is
  // "ready" by construction — pinging the whole tournament at once is noise.
  if (!entry.seen) {
    entry.seen = true;
    for (const p of s.pods) if (podReady(p)) ann.add(p.id);
    persisted.announced[code] = [...ann];
    savePersisted();
    return;
  }

  for (const pod of s.pods) {
    if (!podReady(pod) || ann.has(pod.id)) continue;
    ann.add(pod.id);
    persisted.announced[code] = [...ann];
    savePersisted();
    await announce(code, s, pod);
  }
}

async function announce(code, s, pod) {
  const g = await mainGuild();
  const byTeam = new Map((s.seeds || []).map((sd) => [sd.name, sd.discords || []]));
  const names = pod.teams.map((t) => t.name);
  const mentions = [];
  for (const teamName of names) {
    for (const d of byTeam.get(teamName) || []) {
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
    description: streamed
      ? `${vs}\n\nThis match will be **streamed** ${DASH} wait for the moderator to DM the lobby code.`
      : `${vs}\n\nYour match is **not** on stream ${DASH} please start as soon as possible.`,
    color: streamed ? 0xff4d5e : 0x7c5cff,
    footer: { text: "CODEBREAKERS \u00B7 live bracket" },
    timestamp: new Date().toISOString(),
  };

  console.log(`[${code}] announce ${pod.id}: ${names.join(" vs ")} (${mentions.length} mentions)`);
  if (CFG.announceChannelId) {
    try {
      const ch = await client.channels.fetch(CFG.announceChannelId);
      await ch.send({ content: mentions.join(" "), embeds: [embed] });
    } catch (e) { console.error("announce send failed:", e.message); }
  }
}

// ─── One-shot role sync: node index.js sync-roles CB-XXXX ["Role Name"] ─────
async function syncRoles(code, roleName) {
  const res = await fetch(`${WORKER}/session/${code}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`session ${code}: ${data.error || "not found"}`);
  const s = JSON.parse(data.state);
  const g = await mainGuild();
  if (!g) throw new Error("bot is not in any guild — invite it first");
  const name = roleName || `Tournament: ${data.name || code}`;
  let role = g.roles.cache.find((r) => r.name === name);
  if (!role) role = await g.roles.create({ name, mentionable: true, reason: `CodeBreakers ${code}` });
  let added = 0; const missing = [];
  for (const seed of s.seeds || []) {
    for (const d of seed.discords || []) {
      const m = findMember(g, d);
      if (!m) { missing.push(`${seed.name}: ${d}`); continue; }
      if (!m.roles.cache.has(role.id)) { await m.roles.add(role); added++; }
    }
  }
  console.log(`role "${name}": +${added} members`);
  if (missing.length) console.log("not found on server:\n  " + missing.join("\n  "));
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────
try {
  require("./results")({ client, sessions, CFG, ENV, WORKER, norm, mainGuild });
} catch (e) { console.error("results module failed to load:", e.message); }

const [, , cmd, arg1, arg2] = process.argv;
client.once("clientReady", async () => {
  console.log(`logged in as ${client.user.tag}; guilds: ${[...client.guilds.cache.values()].map((g) => g.name).join(", ") || "none"}`);
  if (cmd === "sync-roles") {
    try { await syncRoles(String(arg1 || "").toUpperCase(), arg2); } catch (e) { console.error("sync-roles failed:", e.message); process.exitCode = 1; }
    client.destroy();
    return;
  }
  pollSessions();
  setInterval(pollSessions, (CFG.pollIntervalSec || 60) * 1000);
});
client.login(TOKEN);
