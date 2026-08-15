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
//
// The site is invite-only, so a session row alone is not access: anyone who is
// not an owner also needs a viewers row. Pass { access: false } for the tests
// that are specifically about somebody who was never let in.
function signIn(id, sid, { access = true } = {}) {
  const ts = store.now();
  store.db.prepare(`INSERT OR REPLACE INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
                    VALUES (?, ?, NULL, NULL, 'viewer', ?, ?)`).run(id, `user${id}`, ts, ts);
  store.db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(sid, id, ts, ts + 3600e3);
  if (access && id !== OWNER) store.addViewer({ discord_id: id, username: `user${id}`, added_by: "test" });
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

// --- invite-only read access ------------------------------------------------

test("a signed-in Discord account that was never invited has no access", async () => {
  const strangerHeaders = signIn("900000000000000777", "sid-stranger", { access: false });
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });

  assert.strictEqual(auth.currentUser({ headers: strangerHeaders }), null,
    "a valid session cookie is not access on its own");
  // And the API agrees: they look signed out, not merely unprivileged.
  assert.strictEqual((await call("GET", "/api/players", { headers: strangerHeaders })).status, 401);
});

test("an invite takes effect on the existing session, and so does removing it", async () => {
  const headers = signIn(OWNER, "sid-owner");
  const stranger = "900000000000000778";
  const strangerHeaders = signIn(stranger, "sid-stranger2", { access: false });
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });

  assert.strictEqual(auth.currentUser({ headers: strangerHeaders }), null);

  const invited = await call("POST", "/api/viewers", { headers, body: { discord_id: stranger, username: "guest" } });
  assert.strictEqual(invited.status, 200);
  const me = auth.currentUser({ headers: strangerHeaders });
  assert.ok(me, "the session they already had now works");
  assert.strictEqual(me.is_admin, false, "read access is not the mod role");
  assert.strictEqual(me.is_owner, false);

  // Revocation has to reach the live session, or a removed person keeps
  // reading for the 30 days their cookie has left.
  const removed = await call("DELETE", `/api/viewers/${stranger}`, { headers });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(auth.currentUser({ headers: strangerHeaders }), null,
    "removing access must end the session they are already using");
});

test("owners and moderators have access without a viewers row", async () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const ownerHeaders = signIn(OWNER, "sid-owner");
  assert.ok(auth.currentUser({ headers: ownerHeaders }), "an owner is never locked out");
  assert.ok(!store.listViewers().some((v) => v.discord_id === OWNER), "and needs no row to prove it");

  const modId = "900000000000000779";
  const modHeaders = signIn(modId, "sid-mod2", { access: false });
  assert.strictEqual(auth.currentUser({ headers: modHeaders }), null);
  store.addModerator({ discord_id: modId, username: "modonly", added_by: "test" });
  assert.ok(auth.currentUser({ headers: modHeaders }), "the mod role carries read access with it");
  store.removeModerator(modId);
});

test("only owners can manage who has access", async () => {
  const modId = "900000000000000780";
  const modHeaders = signIn(modId, "sid-mod3");
  store.addModerator({ discord_id: modId, username: "amod", added_by: "test" });

  assert.strictEqual((await call("GET", "/api/viewers", { headers: modHeaders })).status, 403);
  assert.strictEqual((await call("POST", "/api/viewers", { headers: modHeaders, body: { discord_id: "900000000000000781" } })).status, 403);
  assert.strictEqual((await call("DELETE", "/api/viewers/900000000000000781", { headers: modHeaders })).status, 403);

  store.removeModerator(modId);
});

test("an invite needs a Discord id, and an owner cannot be un-invited", async () => {
  const headers = signIn(OWNER, "sid-owner");

  const bad = await call("POST", "/api/viewers", { headers, body: { discord_id: "someguy" } });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.error || bad.json.error, /Developer Mode/);

  const owner = await call("DELETE", `/api/viewers/${OWNER}`, { headers });
  assert.strictEqual(owner.status, 400, "an owner's access is not revocable over HTTP");
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
