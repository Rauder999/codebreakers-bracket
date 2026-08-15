// ============================================================================
// Moderator store + wiring tests: a /mod grant must reach both gates -- the
// stats-site admin role and the bot-side isModerator -- with no restart and
// no re-login, and revocation must be just as immediate.
//
//   node --test test/mods.test.js
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.CB_STATS_DB = process.env.CB_STATS_DB
  || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-mods-")), "test.db");

const store = require("../stats/db");
const createAuth = require("../web/auth");

// The real config, so a bad edit to config.json fails here rather than in prod.
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));

test("add / check / list / remove round-trip", () => {
  assert.strictEqual(store.isModerator("111"), false);
  store.addModerator({ discord_id: "111", username: "modone", added_by: "playrtbh" });
  assert.strictEqual(store.isModerator("111"), true);
  const row = store.listModerators().find((r) => r.discord_id === "111");
  assert.ok(row, "listModerators must include the new moderator");
  assert.strictEqual(row.added_by, "playrtbh");
  assert.ok(row.added_at > 0, "the grant must be timestamped");
  assert.strictEqual(store.removeModerator("111"), true);
  assert.strictEqual(store.isModerator("111"), false);
  assert.strictEqual(store.removeModerator("111"), false, "second remove reports nothing to do");
});

test("re-adding keeps the original grant audit", () => {
  store.addModerator({ discord_id: "222", username: "two", added_by: "playrtbh" });
  const first = store.listModerators().find((r) => r.discord_id === "222");
  store.addModerator({ discord_id: "222", username: "two-renamed", added_by: "someone-else" });
  const second = store.listModerators().find((r) => r.discord_id === "222");
  assert.strictEqual(second.added_by, "playrtbh", "added_by must survive a re-add");
  assert.strictEqual(second.added_at, first.added_at, "added_at must survive a re-add");
  assert.strictEqual(second.username, "two-renamed", "username may refresh");
  store.removeModerator("222");
});

test("a stored moderator gets the stats-site admin role at request time", () => {
  const auth = createAuth(CFG, { DISCORD_CLIENT_SECRET: "test-secret" });
  const ts = store.now();
  store.db.prepare(`INSERT OR REPLACE INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
                    VALUES ('333', 'discordmod', NULL, NULL, 'viewer', ?, ?)`).run(ts, ts);
  store.db.prepare(`INSERT OR REPLACE INTO sessions (id, discord_id, created_at, expires_at) VALUES ('sid-mod', '333', ?, ?)`)
    .run(ts, ts + 3600e3);
  // The site is invite-only, so give them read access first: this test is
  // about gaining the MOD role on top, not about getting through the door.
  store.addViewer({ discord_id: "333", username: "discordmod", added_by: "test" });
  const req = { headers: { cookie: "cbstats_sid=sid-mod" } };

  assert.strictEqual(auth.currentUser(req).is_admin, false, "not an admin before the grant");
  store.addModerator({ discord_id: "333", username: "discordmod", added_by: "playrtbh" });
  const user = auth.currentUser(req);
  assert.strictEqual(user.is_admin, true, "admin immediately after /mod add, same session");
  assert.strictEqual(user.role, "admin");
  store.removeModerator("333");
  assert.strictEqual(auth.currentUser(req).is_admin, false, "viewer again immediately after /mod remove");
});

test("the bot-side gate honours config owners and stored moderators", () => {
  // mods.js only wires event listeners at setup, so a stub client is enough;
  // cliMode skips the clientReady command registration path entirely.
  const clientStub = { on: () => {}, once: () => {} };
  const mods = require("../mods")({ client: clientStub, CFG, cliMode: true });

  for (const ownerId of CFG.stats.adminDiscordIds) {
    assert.strictEqual(mods.isModerator(ownerId), true, `config owner ${ownerId} must always be a moderator`);
  }
  assert.strictEqual(mods.isModerator("444"), false);
  store.addModerator({ discord_id: "444", username: "four", added_by: "test" });
  assert.strictEqual(mods.isModerator("444"), true, "stored moderators pass the bot-side gate");

  // Dispute pings (results.js) go to owners + stored moderators, deduped.
  const ids = mods.moderatorIds();
  for (const ownerId of CFG.stats.adminDiscordIds) assert.ok(ids.includes(ownerId), "owners are pinged on disputes");
  assert.ok(ids.includes("444"), "stored moderators are pinged on disputes");
  assert.strictEqual(new Set(ids).size, ids.length, "the ping list has no duplicates");

  store.removeModerator("444");
  assert.strictEqual(mods.isModerator("444"), false);
  assert.strictEqual(mods.isModerator(null), false, "a missing id is never a moderator");
});
