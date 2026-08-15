// ============================================================================
// Users page endpoints: who may hand out the moderator role, and what happens
// when they do.
//
// The rule these pin down is "mods can moderate, owners can appoint". A mod
// who could appoint mods is a privilege-escalation bug, not a convenience, so
// the 403 tests below matter more than the happy paths.
//
//   node --test test/users.test.js
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");

process.env.CB_STATS_DB = process.env.CB_STATS_DB
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-users-")), "test.db");

const store = require("../stats/db");
const { handle } = require("../web/server");
const createAuth = require("../web/auth");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
const OWNER = String(CFG.stats.adminDiscordIds[0]);
const MOD = "900000000000000001";
const TARGET = "900000000000000002";

// --- harness ----------------------------------------------------------------

// A signed-in session for `id`, returned as the cookie header the router reads.
function signIn(id, sid) {
  const ts = store.now();
  store.db.prepare(`INSERT OR REPLACE INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
                    VALUES (?, ?, NULL, NULL, 'viewer', ?, ?)`).run(id, `user${id}`, ts, ts);
  store.db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(sid, id, ts, ts + 3600e3);
  return { cookie: `cbstats_sid=${sid}` };
}

// Drives the real router with a stub response, so the assertions below are
// against the same code path a browser hits.
async function call(method, url, { headers = {}, body } = {}) {
  // Buffers, not strings: readBody concatenates chunks the way a real request
  // delivers them, and a string chunk would throw inside Buffer.concat.
  const req = body === undefined ? new Readable({ read() { this.push(null); } })
    : Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = method;
  req.url = url;
  req.headers = headers;

  const res = {
    statusCode: 0, headers: {}, body: "", headersSent: false,
    writeHead(status, h) { this.statusCode = status; Object.assign(this.headers, h || {}); this.headersSent = true; },
    end(chunk) { this.body = chunk == null ? "" : String(chunk); this.done = true; },
  };

  await handle(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* static or plain-text response */ }
  return { status: res.statusCode, json };
}

// --- tests ------------------------------------------------------------------

test("an owner sees the owner list and the moderators", async () => {
  const headers = signIn(OWNER, "sid-owner");
  const { status, json } = await call("GET", "/api/users", { headers });
  assert.strictEqual(status, 200);
  assert.ok(json.owners.includes(OWNER), "the caller's own id must be in the owner list");
  assert.ok(Array.isArray(json.moderators));
});

test("a moderator cannot read or change who the moderators are", async () => {
  const headers = signIn(MOD, "sid-mod");
  store.addModerator({ discord_id: MOD, username: "amod", added_by: "test" });

  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const me = auth.currentUser({ headers });
  assert.strictEqual(me.is_admin, true, "precondition: they really are a moderator");
  assert.strictEqual(me.is_owner, false, "a granted moderator must never become an owner");

  assert.strictEqual((await call("GET", "/api/users", { headers })).status, 403);
  assert.strictEqual((await call("POST", "/api/users", { headers, body: { discord_id: TARGET } })).status, 403);
  assert.strictEqual((await call("DELETE", `/api/users/${TARGET}`, { headers })).status, 403);

  store.removeModerator(MOD);
});

test("a signed-out visitor gets 401, not 403", async () => {
  const { status } = await call("GET", "/api/users", { headers: {} });
  assert.strictEqual(status, 401, "no session must fail the login gate before the owner gate");
});

test("granting takes effect on the grantee's next request", async () => {
  const headers = signIn(OWNER, "sid-owner");
  const targetHeaders = signIn(TARGET, "sid-target");
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });

  assert.strictEqual(auth.currentUser({ headers: targetHeaders }).is_admin, false);

  const { status, json } = await call("POST", "/api/users", { headers, body: { discord_id: TARGET, username: "newmod" } });
  assert.strictEqual(status, 200);
  assert.ok(json.moderators.some((r) => r.discord_id === TARGET), "the response carries the updated list");

  // No re-login, no restart: the same session is now an admin.
  const after = auth.currentUser({ headers: targetHeaders });
  assert.strictEqual(after.is_admin, true);
  assert.strictEqual(after.is_owner, false);

  const row = store.listModerators().find((r) => r.discord_id === TARGET);
  assert.strictEqual(row.added_by, `user${OWNER}`, "the grant records who made it");
});

test("revoking takes effect just as fast", async () => {
  const headers = signIn(OWNER, "sid-owner");
  const targetHeaders = signIn(TARGET, "sid-target");
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });

  const { status, json } = await call("DELETE", `/api/users/${TARGET}`, { headers });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.removed, true);
  assert.strictEqual(auth.currentUser({ headers: targetHeaders }).is_admin, false);
});

test("a username is not accepted where a Discord id is required", async () => {
  const headers = signIn(OWNER, "sid-owner");
  for (const bad of ["rauder.", "", "12345", "not-an-id", "9000000000000000000000000"]) {
    const { status, json } = await call("POST", "/api/users", { headers, body: { discord_id: bad } });
    assert.strictEqual(status, 400, `"${bad}" must be rejected`);
    assert.match(json.error, /Developer Mode/, "the error should say how to find the id");
  }
  assert.strictEqual(store.listModerators().length, 0, "nothing was written by the rejected calls");
});

test("owners cannot be granted, revoked or removed through the API", async () => {
  const headers = signIn(OWNER, "sid-owner");

  const granted = await call("POST", "/api/users", { headers, body: { discord_id: OWNER } });
  assert.strictEqual(granted.status, 400, "an owner already holds the role; a row would be misleading");

  const removed = await call("DELETE", `/api/users/${OWNER}`, { headers });
  assert.strictEqual(removed.status, 400, "removing an owner must require editing config.json on the VM");

  // The important half: the owner still has their powers after both attempts.
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const me = auth.currentUser({ headers });
  assert.strictEqual(me.is_owner, true);
  assert.strictEqual(me.is_admin, true);
});
