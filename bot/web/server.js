// ============================================================================
// cb-stats-web -- the CodeBreakers stats service.
//
// Runs as its own systemd unit, separate from the bot, sharing one SQLite file
// in WAL mode. Deliberately separate: the bot's match pings are the thing that
// must never go down, and a web request should never be able to take them with
// it.
//
// Two tiers of endpoint:
//   /api/public/*  no auth, CORS-allowlisted. Exactly enough for the bracket
//                  site to show a per-match stat table, and nothing more.
//   /api/*         Discord login required. Search, profiles, leaderboards,
//                  aggregates, CSV export. PATCH needs the admin role.
// ============================================================================
const fs = require("fs");
const path = require("path");
const http = require("http");
const url = require("url");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
const envPath = path.join(__dirname, "..", ".env");
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const ENV = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const Q = require("./queries");
const createAuth = require("./auth");
const auth = createAuth(CFG, ENV);

const S = CFG.stats || {};
const PORT = Number(S.port) || 8110;
const BIND = S.bind || "0.0.0.0";
const PUBLIC_ORIGINS = new Set(S.publicOrigins || []);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// --- plumbing ---------------------------------------------------------------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}
const sendJson = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", ...headers });

// CORS is granted only to the origins in config, and only on /api/public/*.
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !PUBLIC_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  // Never let a crafted path escape the public directory.
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "not found");
    send(res, 200, buf, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  });
}

// Shared filter parsing for the aggregate endpoints.
function filtersFrom(q) {
  return {
    tournament: q.tournament || null,
    player_id: q.player_id || null,
    team_id: q.team_id || null,
    match_id: q.match_id || null,
    class: q.class || null,
    map: q.map || null,
    from: q.from ? Number(q.from) : null,
    to: q.to ? Number(q.to) : null,
    include_disconnected: q.include_disconnected === "1" || q.include_disconnected === "true",
  };
}
const optsFrom = (q) => ({ sort: q.sort, dir: q.dir, limit: q.limit, offset: q.offset, minMatches: q.min_matches });

// --- routing ----------------------------------------------------------------

async function handle(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const q = parsed.query;
  const isPublicApi = pathname.startsWith("/api/public/");

  if (req.method === "OPTIONS") return send(res, 204, "", isPublicApi ? corsHeaders(req) : {});

  // --- public read API (the bracket site) ---
  if (isPublicApi) {
    const cors = corsHeaders(req);
    if (pathname === "/api/public/match") {
      const { code, pod, id } = q;
      const detail = id ? Q.getMatchById(id) : (code && pod ? Q.getMatchByPod(String(code).toUpperCase(), pod) : null);
      if (!detail) return sendJson(res, 404, { ok: false, error: "no stats recorded for that match" }, cors);
      return sendJson(res, 200, { ok: true, ...detail }, cors);
    }
    if (pathname === "/api/public/matches") {
      if (!q.tournament) return sendJson(res, 400, { ok: false, error: "tournament is required" }, cors);
      return sendJson(res, 200, { ok: true, matches: Q.listMatches({ tournament: String(q.tournament).toUpperCase(), limit: q.limit }) }, cors);
    }
    return sendJson(res, 404, { ok: false, error: "unknown endpoint" }, cors);
  }

  // --- auth ---
  if (pathname === "/auth/login") {
    if (!auth.enabled) return send(res, 503, "Discord login is not configured yet.");
    return send(res, 302, "", { Location: auth.loginUrl(typeof q.next === "string" ? q.next : "/") });
  }
  if (pathname === "/auth/callback") {
    if (!auth.enabled) return send(res, 503, "Discord login is not configured yet.");
    if (q.error) return send(res, 400, `Discord returned: ${q.error}`);
    try {
      const out = await auth.completeCallback(String(q.code || ""), String(q.state || ""));
      if (out.error) return send(res, 403, out.error, { "Content-Type": "text/plain; charset=utf-8" });
      return send(res, 302, "", { Location: out.returnTo || "/", "Set-Cookie": auth.sessionCookie(out.sid, out.maxAge) });
    } catch (e) {
      console.error("auth callback:", e.message);
      return send(res, 500, "login failed, please try again");
    }
  }
  if (pathname === "/auth/logout" && req.method === "POST") {
    auth.logout(req);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie() });
  }

  const user = auth.currentUser(req);

  if (pathname === "/api/me") {
    return sendJson(res, 200, { ok: true, user, login_configured: auth.enabled });
  }

  // --- everything else below needs a session ---
  if (pathname.startsWith("/api/")) {
    if (!user) return sendJson(res, 401, { ok: false, error: "sign in with Discord to view stats" });

    try {
      if (pathname === "/api/tournaments") return sendJson(res, 200, { ok: true, tournaments: Q.listTournaments() });
      if (pathname === "/api/maps") return sendJson(res, 200, { ok: true, maps: Q.listMaps() });

      if (pathname === "/api/players") {
        if (q.q) return sendJson(res, 200, { ok: true, players: Q.searchPlayers(q.q, q.limit) });
        return sendJson(res, 200, { ok: true, players: Q.buildAggregate("player", filtersFrom(q), optsFrom(q)) });
      }
      let m = pathname.match(/^\/api\/players\/(\d+)$/);
      if (m) {
        const profile = Q.playerProfile(m[1]);
        return profile ? sendJson(res, 200, { ok: true, ...profile }) : sendJson(res, 404, { ok: false, error: "player not found" });
      }

      if (pathname === "/api/teams") {
        if (q.q) return sendJson(res, 200, { ok: true, teams: Q.searchTeams(q.q, q.tournament, q.limit) });
        return sendJson(res, 200, { ok: true, teams: Q.buildAggregate("team", filtersFrom(q), optsFrom(q)) });
      }
      m = pathname.match(/^\/api\/teams\/(\d+)$/);
      if (m) {
        const profile = Q.teamProfile(m[1]);
        return profile ? sendJson(res, 200, { ok: true, ...profile }) : sendJson(res, 404, { ok: false, error: "team not found" });
      }

      if (pathname === "/api/matches") {
        return sendJson(res, 200, { ok: true, matches: Q.listMatches({ tournament: q.tournament, limit: q.limit, offset: q.offset }) });
      }
      m = pathname.match(/^\/api\/matches\/(\d+)$/);
      if (m) {
        const detail = Q.getMatchById(m[1]);
        return detail ? sendJson(res, 200, { ok: true, ...detail }) : sendJson(res, 404, { ok: false, error: "match not found" });
      }
      m = pathname.match(/^\/api\/matches\/(\d+)\/edits$/);
      if (m) return sendJson(res, 200, { ok: true, edits: Q.matchEdits(m[1]) });

      // The averages engine. group_by = player|team|class|map|tournament|match
      if (pathname === "/api/aggregate" || pathname === "/api/leaderboard") {
        const groupBy = q.group_by || "player";
        if (!Q.DIMENSIONS[groupBy]) {
          return sendJson(res, 400, { ok: false, error: `unknown group_by (try: ${Object.keys(Q.DIMENSIONS).join(", ")})` });
        }
        const rows = Q.buildAggregate(groupBy, filtersFrom(q), optsFrom(q));
        return sendJson(res, 200, { ok: true, group_by: groupBy, rows });
      }

      if (pathname === "/api/export.csv") {
        const groupBy = q.group_by || "player";
        if (!Q.DIMENSIONS[groupBy]) return sendJson(res, 400, { ok: false, error: "unknown group_by" });
        const rows = Q.buildAggregate(groupBy, filtersFrom(q), { ...optsFrom(q), limit: 500 });
        return send(res, 200, Q.toCsv(rows), {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="cb-stats-${groupBy}.csv"`,
        });
      }

      // --- admin ---
      m = pathname.match(/^\/api\/match-players\/(\d+)$/);
      if (m && req.method === "PATCH") {
        if (!user.is_admin) return sendJson(res, 403, { ok: false, error: "moderator role required" });
        const body = await readBody(req);
        const out = Q.editMatchPlayer(m[1], body, user.username || user.discord_id);
        return out.error ? sendJson(res, 400, { ok: false, error: out.error }) : sendJson(res, 200, { ok: true, row: out.row });
      }

      return sendJson(res, 404, { ok: false, error: "unknown endpoint" });
    } catch (e) {
      console.error(`api ${pathname}:`, e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method !== "GET") return send(res, 405, "method not allowed");
  return serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("unhandled:", e.message);
    if (!res.headersSent) send(res, 500, "internal error");
  });
});

server.listen(PORT, BIND, () => {
  console.log(`cb-stats-web listening on ${BIND}:${PORT}`);
  console.log(`  auth: ${auth.enabled ? "Discord OAuth ready" : "DISABLED (not configured)"}`);
  console.log(`  public CORS origins: ${[...PUBLIC_ORIGINS].join(", ") || "(none)"}`);
});
