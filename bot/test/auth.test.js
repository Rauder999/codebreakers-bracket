// ============================================================================
// Auth wiring tests. These do not talk to Discord -- they pin the parts we
// would otherwise only discover were wrong on the day the client secret
// arrives: the redirect URI, the scopes, the guild gate and who is an admin.
//
//   node --test test/auth.test.js
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.CB_STATS_DB = process.env.CB_STATS_DB
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-auth-")), "test.db");

const createAuth = require("../web/auth");
const { db, now } = require("../stats/db");

// The real config, so a bad edit to config.json fails here rather than in prod.
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
const PLAYR = "743956656429203535";
const RAUDER = "614861553790877709";

test("config names Playr and Rauder as admins", () => {
  assert.ok(CFG.stats.adminDiscordIds.includes(PLAYR), "Playr must be an admin");
  assert.ok(CFG.stats.adminDiscordIds.includes(RAUDER), "Rauder must be an admin");
});

test("viewing is gated to a Discord server, not open to any account", () => {
  const gate = CFG.stats.requireGuildId;
  const ids = Array.isArray(gate) ? gate : [gate].filter(Boolean);
  assert.ok(ids.length > 0, "requireGuildId must be set or anyone with Discord can read the stats");
});

test("login URL carries the right redirect, scopes and state", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  assert.strictEqual(auth.enabled, true, "should be enabled once a secret exists");

  const u = new URL(auth.loginUrl("/#/players"));
  assert.strictEqual(u.origin + u.pathname, "https://discord.com/oauth2/authorize");
  assert.strictEqual(u.searchParams.get("client_id"), CFG.stats.discordClientId);
  assert.strictEqual(u.searchParams.get("redirect_uri"), "https://stats.playrservers.com/auth/callback");
  assert.strictEqual(u.searchParams.get("response_type"), "code");
  // The guild gate needs the guilds scope, or the membership check cannot run.
  assert.deepStrictEqual(u.searchParams.get("scope").split(" ").sort(), ["guilds", "identify"]);
  assert.ok(u.searchParams.get("state"), "state is required to stop CSRF on the callback");
});

test("a callback with an unknown state is rejected", async () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const out = await auth.completeCallback("some-code", "never-issued");
  assert.match(out.error, /expired|not started/);
});

test("auth stays disabled, loudly, when the secret is missing", () => {
  const auth = createAuth(CFG, {});
  assert.strictEqual(auth.enabled, false);
});

test("admin comes from config at request time, not from the stored row", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const ts = now();

  // Seed a session whose stored role is stale/wrong on purpose.
  db.prepare(`INSERT OR REPLACE INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
              VALUES (?, 'playrtbh', 'Playr', NULL, 'viewer', ?, ?)`).run(PLAYR, ts, ts);
  db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES ('sid-playr', ?, ?, ?)`)
    .run(PLAYR, ts, ts + 3600e3);

  const req = { headers: { cookie: "cbstats_sid=sid-playr" } };
  const user = auth.currentUser(req);
  assert.strictEqual(user.is_admin, true, "config must win over the stale stored role");
  assert.strictEqual(user.role, "admin");
});

test("a non-admin member is a viewer", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const ts = now();
  db.prepare(`INSERT OR REPLACE INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
              VALUES ('999', 'someone', NULL, NULL, 'admin', ?, ?)`).run(ts, ts);
  db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES ('sid-other', '999', ?, ?)`)
    .run(ts, ts + 3600e3);

  const user = auth.currentUser({ headers: { cookie: "cbstats_sid=sid-other" } });
  assert.strictEqual(user.is_admin, false, "a stored role of admin must not grant admin");
});

test("an expired session is not a session", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const ts = now();
  db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES ('sid-old', ?, ?, ?)`)
    .run(PLAYR, ts - 7200e3, ts - 3600e3);
  assert.strictEqual(auth.currentUser({ headers: { cookie: "cbstats_sid=sid-old" } }), null);
});

test("logout destroys the session server-side", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const ts = now();
  db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES ('sid-bye', ?, ?, ?)`)
    .run(PLAYR, ts, ts + 3600e3);
  const req = { headers: { cookie: "cbstats_sid=sid-bye" } };
  assert.ok(auth.currentUser(req));
  auth.logout(req);
  assert.strictEqual(auth.currentUser(req), null);
});

test("session cookies are HttpOnly, SameSite and Secure on https", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const c = auth.sessionCookie("abc", 3600);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/, "baseUrl is https, so the cookie must be Secure");
});
