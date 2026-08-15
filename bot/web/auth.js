// ============================================================================
// Discord OAuth + cookie sessions for the stats site.
//
// Why Discord rather than local accounts: the bracket's live.html already
// signs people in with Discord, the tournament roster is keyed on Discord
// usernames, and it means nobody has to be issued another password.
//
// Access control has three gates, in order:
//   1. requireGuildId  -- if set, the user must be a member of that guild.
//                         This is the real gate; it keeps the site to the
//                         community rather than to anyone with a Discord
//                         account. Needs the "guilds" scope.
//   2. allowDiscordIds -- if non-empty, an explicit allowlist on top.
//   3. adminDiscordIds -- the OWNERS. They get the admin ("mod") role, and
//                         they alone can grant it to others on the Users page,
//                         which writes the moderators table. Anyone in that
//                         table gets the mod role too, resolved per request.
//
// Sessions are opaque random ids in a table, not JWTs: logout and revocation
// then actually work, and there is no signing key to leak.
// ============================================================================
const crypto = require("crypto");
const { db, now, isModerator, addModerator } = require("../stats/db");

const DISCORD_API = "https://discord.com/api/v10";
const COOKIE = "cbstats_sid";

const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (discord_id, username, global_name, avatar, role, created_at, last_login_at)
    VALUES (@discord_id, @username, @global_name, @avatar, @role, @ts, @ts)
    ON CONFLICT(discord_id) DO UPDATE SET
      username      = excluded.username,
      global_name   = excluded.global_name,
      avatar        = excluded.avatar,
      role          = excluded.role,
      last_login_at = excluded.last_login_at
  `),
  insSession: db.prepare(`INSERT INTO sessions (id, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)`),
  delSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
  gcSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
  getSession: db.prepare(`
    SELECT s.id, s.expires_at, u.discord_id, u.username, u.global_name, u.avatar, u.role
      FROM sessions s JOIN users u ON u.discord_id = s.discord_id
     WHERE s.id = ? AND s.expires_at > ?
  `),
};

// --- cookies ----------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge, secure, expire } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) bits.push("Secure");
  if (expire) bits.push("Max-Age=0");
  else if (maxAge) bits.push(`Max-Age=${maxAge}`);
  return bits.join("; ");
}

// ---------------------------------------------------------------------------

module.exports = function createAuth(CFG, ENV) {
  const S = CFG.stats || {};
  const clientId = S.discordClientId || "";
  const clientSecret = ENV.DISCORD_CLIENT_SECRET || "";
  const baseUrl = String(S.baseUrl || "").replace(/\/$/, "");
  const redirectUri = `${baseUrl}/auth/callback`;
  const sessionDays = Number(S.sessionDays) > 0 ? Number(S.sessionDays) : 30;
  const secureCookies = baseUrl.startsWith("https://");
  const adminIds = new Set(S.adminDiscordIds || []);
  const allowIds = new Set(S.allowDiscordIds || []);
  // Accepts a single id or a list. A list matters because the bot is moving
  // from Rauder's test server to the production CODE server: naming both means
  // the move does not lock anyone out mid-transition.
  const requireGuildIds = (Array.isArray(S.requireGuildId) ? S.requireGuildId : [S.requireGuildId])
    .filter(Boolean);

  const enabled = !!(clientId && clientSecret && baseUrl);
  if (!enabled) {
    console.log("auth: Discord OAuth not configured (need stats.discordClientId, stats.baseUrl and DISCORD_CLIENT_SECRET) \u2014 login disabled");
  }

  const scopes = ["identify"].concat(requireGuildIds.length ? ["guilds"] : []);
  const pendingStates = new Map(); // state -> { at, returnTo }

  function loginUrl(returnTo) {
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, { at: Date.now(), returnTo: returnTo || "/" });
    // Keep the map from growing without bound if people abandon logins.
    for (const [k, v] of pendingStates) if (Date.now() - v.at > 10 * 60 * 1000) pendingStates.delete(k);
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      prompt: "none",
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  async function exchangeCode(code) {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
    return res.json();
  }

  async function discordGet(path, accessToken) {
    const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`discord ${path} failed (${res.status})`);
    return res.json();
  }

  /**
   * Complete the OAuth dance. Returns { sid, maxAge, returnTo } on success or
   * { error } if the user is not allowed in.
   */
  async function completeCallback(code, state) {
    const pending = state && pendingStates.get(state);
    if (!pending) return { error: "login expired or was not started here, please try again" };
    pendingStates.delete(state);

    const token = await exchangeCode(code);
    const me = await discordGet("/users/@me", token.access_token);

    if (requireGuildIds.length) {
      const guilds = await discordGet("/users/@me/guilds", token.access_token);
      if (!guilds.some((g) => requireGuildIds.includes(g.id))) {
        return { error: "you must be a member of the CodeBreakers Discord to view stats" };
      }
    }
    if (allowIds.size && !allowIds.has(me.id)) {
      return { error: "this account is not on the stats allowlist" };
    }

    const ts = now();
    stmts.upsertUser.run({
      discord_id: me.id,
      username: me.username || null,
      global_name: me.global_name || null,
      avatar: me.avatar || null,
      role: adminIds.has(me.id) || isModerator(me.id) ? "admin" : "viewer",
      ts,
    });
    // A mod granted by raw id (before their first sign-in) has no stored
    // username; their login is the first chance to fill it in. addModerator
    // refreshes the username only -- added_by / added_at audit is preserved.
    if (!adminIds.has(me.id) && isModerator(me.id) && me.username) {
      addModerator({ discord_id: me.id, username: me.username });
    }

    const sid = crypto.randomBytes(32).toString("hex");
    const maxAge = sessionDays * 24 * 3600;
    stmts.insSession.run(sid, me.id, ts, ts + maxAge * 1000);
    stmts.gcSessions.run(ts);
    return { sid, maxAge, returnTo: pending.returnTo };
  }

  const sessionCookie = (sid, maxAge) => serializeCookie(COOKIE, sid, { maxAge, secure: secureCookies });
  const clearCookie = () => serializeCookie(COOKIE, "", { expire: true, secure: secureCookies });

  function currentUser(req) {
    const sid = parseCookies(req)[COOKIE];
    if (!sid) return null;
    const row = stmts.getSession.get(sid, now());
    if (!row) return null;
    // Admin comes from config + the moderators table on every request, not
    // from the row written at login: granting somebody the mod role on the
    // Users page takes effect on their next click instead of requiring them
    // to sign out and back in. is_owner (config only) gates that page.
    const isOwner = adminIds.has(row.discord_id);
    const isAdmin = isOwner || isModerator(row.discord_id);
    return {
      discord_id: row.discord_id,
      username: row.username,
      global_name: row.global_name,
      avatar: row.avatar,
      role: isAdmin ? "admin" : "viewer",
      is_admin: isAdmin,
      is_owner: isOwner,
    };
  }

  function logout(req) {
    const sid = parseCookies(req)[COOKIE];
    if (sid) stmts.delSession.run(sid);
  }

  return {
    enabled, loginUrl, completeCallback, currentUser, logout,
    sessionCookie, clearCookie, COOKIE,
  };
};
