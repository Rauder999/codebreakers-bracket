// ============================================================================
// Codebreakers operator API — Phase 2a (accounts / invites / ownership)
// ----------------------------------------------------------------------------
// Adds multi-tenant auth on top of the Phase 1b realtime engine:
//   • Invite codes (super-admin mints, one-time) -> organizer accounts
//   • Accounts with PBKDF2-hashed passwords in KV (survive all redeploys)
//   • Signed session tokens (HMAC-SHA256 with AUTH_SECRET), ~1 year
//   • Per-session ownership; only owner / super-admin / co-host token may write
//   • Per-session co-host tokens (write access to a single tournament)
//
// Backwards compatible: the master token (ADMIN_TOKEN) still works everywhere
// as "super-admin" (owner id "operator"), and /sessions/active without a token
// still returns everything — so the current frontend keeps working until the
// Phase 2b login UI ships.
//
//   POST /auth/redeem   { invite, name, password }  -> { token, accountId, name }
//   POST /auth/login    { name, password }          -> { token, accountId, name }
//   GET  /auth/me       (Authorization: Bearer)     -> { accountId, name }
//   POST /invites       (X-Admin-Token: master)     -> { code }
//   GET  /invites       (X-Admin-Token: master)     -> { invites: [...] }
//   POST /session/:code/share  (owner)              -> { code, token }  co-host
//   POST /archives      (account/master)            -> { id }  frozen snapshot
//   GET  /archives      (public)                    -> { archives: [...] }
//   GET  /archive/:id   (public)                    -> full snapshot
//   DELETE /archive/:id (owner/master)              -> { ok }
//   ... plus all Phase 1b session / bracket / ws routes
// ============================================================================

import { propagate, getPhaseGraph } from "../../client/src/lib/bracketEngine";

// Super-admin master password lives in the ADMIN_TOKEN secret
// (`npx wrangler secret put ADMIN_TOKEN`) — never hardcode it: this repo is public.
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_TOKEN_TTL = 365 * 24 * 60 * 60 * 1000;
const COHOST_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();
function randBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function b64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function b64url(bytes) { return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return unb64(s); }

async function hashPassword(password, saltBytes) {
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" }, km, 256);
  return new Uint8Array(bits);
}
async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}
async function verifyToken(token, secret) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64url(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// Resolve a token string into an identity. Master token wins; else verify JWT-ish.
async function resolveIdentity(tokenStr, env) {
  if (!tokenStr) return { kind: "none" };
  if (env.ADMIN_TOKEN && tokenStr === env.ADMIN_TOKEN) return { kind: "master", accountId: "operator", name: "Operator" };
  const p = await verifyToken(tokenStr, env.AUTH_SECRET);
  if (!p) return { kind: "none" };
  if (p.kind === "account") return { kind: "account", accountId: p.sub, name: p.name };
  if (p.kind === "cohost") return { kind: "cohost", code: p.code, name: p.name || "Co-host" };
  if (p.kind === "discord") return { kind: "discord", discordId: p.sub, uname: p.uname, name: p.name || p.uname, avatar: p.avatar || null };
  return { kind: "none" };
}

// Normalize a Discord handle for roster matching: lowercase, no @, no #discriminator.
function normDiscord(s) {
  return String(s || "").toLowerCase().trim().replace(/^@/, "").split("#")[0];
}
function canWrite(idn, owner, code) {
  if (idn.kind === "master") return true;
  if (idn.kind === "account") return owner == null || owner === idn.accountId;
  if (idn.kind === "cohost") return idn.code === code;
  return false;
}
function ownerToSet(idn, owner) {
  if (owner != null) return owner;
  if (idn.kind === "account") return idn.accountId;
  if (idn.kind === "master") return "operator";
  return null;
}
function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function makeCode(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return prefix + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : (request.headers.get("X-Admin-Token") || "");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ── Auth: redeem invite -> create account ──────────────────────────────
    if (path === "/auth/redeem" && method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      const invite = String(body.invite || "").trim().toUpperCase();
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!invite || !name || password.length < 6) return json({ ok: false, error: "Invite, name and a 6+ char password are required" }, 400);
      const inv = await env.OPERATOR_KV.get(`invite:${invite}`, "json");
      if (!inv) return json({ ok: false, error: "Invalid invite code" }, 400);
      if (inv.usedBy) return json({ ok: false, error: "This invite has already been used" }, 400);
      const accountId = slugify(name);
      if (!accountId) return json({ ok: false, error: "Invalid account name" }, 400);
      if (await env.OPERATOR_KV.get(`account:${accountId}`)) return json({ ok: false, error: "That name is taken" }, 409);
      const salt = randBytes(16);
      const hash = await hashPassword(password, salt);
      const account = { accountId, name, saltB64: b64(salt), hashB64: b64(hash), createdAt: new Date().toISOString() };
      await env.OPERATOR_KV.put(`account:${accountId}`, JSON.stringify(account));
      await env.OPERATOR_KV.put(`invite:${invite}`, JSON.stringify({ ...inv, usedBy: accountId, usedAt: new Date().toISOString() }));
      const iat = Date.now();
      const token = await signToken({ kind: "account", sub: accountId, name, iat, exp: iat + ACCOUNT_TOKEN_TTL }, env.AUTH_SECRET);
      return json({ ok: true, token, accountId, name });
    }

    // ── Auth: login ────────────────────────────────────────────────────────
    if (path === "/auth/login" && method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      const accountId = slugify(body.name || "");
      const password = String(body.password || "");
      const account = await env.OPERATOR_KV.get(`account:${accountId}`, "json");
      if (!account) return json({ ok: false, error: "Account not found" }, 404);
      const hash = await hashPassword(password, unb64(account.saltB64));
      if (b64(hash) !== account.hashB64) return json({ ok: false, error: "Wrong password" }, 401);
      const iat = Date.now();
      const token = await signToken({ kind: "account", sub: accountId, name: account.name, iat, exp: iat + ACCOUNT_TOKEN_TTL }, env.AUTH_SECRET);
      return json({ ok: true, token, accountId, name: account.name });
    }

    // ── Auth: whoami ───────────────────────────────────────────────────────
    if (path === "/auth/me" && method === "GET") {
      const idn = await resolveIdentity(bearer(request), env);
      if (idn.kind === "none") return json({ ok: false }, 401);
      return json({ ok: true, kind: idn.kind, accountId: idn.accountId ?? null, name: idn.name ?? null });
    }

    // ── Invites (super-admin only) ─────────────────────────────────────────
    if (path === "/invites") {
      if (!env.ADMIN_TOKEN || bearer(request) !== env.ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
      if (method === "POST") {
        let body = {}; try { body = await request.json(); } catch { /* optional */ }
        const code = makeCode("INV-");
        await env.OPERATOR_KV.put(`invite:${code}`, JSON.stringify({ createdAt: new Date().toISOString(), note: (body && body.note) || "", usedBy: null }));
        return json({ ok: true, code });
      }
      if (method === "GET") {
        const list = await env.OPERATOR_KV.list({ prefix: "invite:" });
        const invites = [];
        for (const k of list.keys) {
          const v = await env.OPERATOR_KV.get(k.name, "json");
          if (v) invites.push({ code: k.name.replace(/^invite:/, ""), note: v.note || "", usedBy: v.usedBy || null, createdAt: v.createdAt || null });
        }
        invites.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
        return json({ ok: true, invites });
      }
    }

    // ── Active sessions (owner-scoped when an account token is supplied) ────
    if (path === "/sessions/active" && method === "GET") {
      const idn = await resolveIdentity(bearer(request) || url.searchParams.get("token"), env);
      const list = await env.OPERATOR_KV.list({ prefix: "room:" });
      const now = Date.now();
      const active = [];
      for (const k of list.keys) {
        const md = k.metadata || {};
        const updated = md.updatedAt ? Date.parse(md.updatedAt) : 0;
        if (now - updated > ACTIVE_WINDOW_MS) continue;
        // Filtering: account -> only own; master/none -> all (legacy-compatible).
        if (idn.kind === "account" && md.owner && md.owner !== idn.accountId) continue;
        active.push({
          code: k.name.replace(/^room:/, ""),
          name: md.name || "Untitled Tournament",
          size: md.size || null,
          mode: md.mode || null,
          host: md.host || null,
          owner: md.owner || null,
          updatedAt: md.updatedAt || null,
        });
      }
      active.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
      return json({ ok: true, sessions: active });
    }

    // ── Per-session co-host share token (owner or super-admin) ─────────────
    const shareMatch = path.match(/^\/session\/([A-Za-z0-9\-]+)\/share$/);
    if (shareMatch && method === "POST") {
      const code = shareMatch[1].toUpperCase();
      const idn = await resolveIdentity(bearer(request), env);
      // Need the current owner from the DO to authorize.
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(code));
      const ownerRes = await stub.fetch(new Request(`https://do/session/${code}/owner`));
      const { owner } = await ownerRes.json();
      if (!(idn.kind === "master" || (idn.kind === "account" && owner === idn.accountId))) {
        return json({ ok: false, error: "Only the owner can share this tournament" }, 401);
      }
      const iat = Date.now();
      const token = await signToken({ kind: "cohost", code, name: "Co-host", iat, exp: iat + COHOST_TOKEN_TTL }, env.AUTH_SECRET);
      return json({ ok: true, code, token });
    }

    // ── Discord OAuth (player identity for match chats) ────────────────────
    // GET /discord/login?return=<url>  -> 302 to Discord authorize
    // GET /discord/callback            -> exchange code, 302 back with #discord=<token>
    // GET /discord/me                  -> whoami for the chat UI
    const DISCORD_RETURN_OK = (u) => u.startsWith("https://rauder999.github.io/") || u.startsWith("http://localhost");

    if (path === "/discord/login" && method === "GET") {
      if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return json({ ok: false, error: "Discord login is not configured yet" }, 503);
      const ret = url.searchParams.get("return") || "";
      if (!DISCORD_RETURN_OK(ret)) return json({ ok: false, error: "Invalid return URL" }, 400);
      const iat = Date.now();
      const state = await signToken({ kind: "dstate", ret, iat, exp: iat + 10 * 60 * 1000 }, env.AUTH_SECRET);
      const redirectUri = `${url.origin}/discord/callback`;
      const q = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "identify",
        state,
      }).toString();
      // mode=app: deep-link into the installed Discord client, where players are
      // already logged in. After approval Discord opens the callback in the
      // system browser. The web flow stays as fallback.
      if (url.searchParams.get("mode") === "app") {
        return new Response(null, { status: 302, headers: { Location: `discord://-/oauth2/authorize?${q}`, ...CORS } });
      }
      return Response.redirect(`https://discord.com/oauth2/authorize?${q}`, 302);
    }

    if (path === "/discord/callback" && method === "GET") {
      const code = url.searchParams.get("code");
      const stateStr = url.searchParams.get("state");
      const st = await verifyToken(stateStr, env.AUTH_SECRET);
      if (!st || st.kind !== "dstate" || !DISCORD_RETURN_OK(st.ret)) return json({ ok: false, error: "Bad state" }, 400);
      if (!code) return Response.redirect(`${st.ret}#discord_error=denied`, 302);
      const redirectUri = `${url.origin}/discord/callback`;
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) {
        console.log("discord exchange failed", tokenRes.status, await tokenRes.text());
        return Response.redirect(`${st.ret}#discord_error=exchange`, 302);
      }
      const tok = await tokenRes.json();
      const meRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!meRes.ok) {
        console.log("discord /users/@me failed", meRes.status, await meRes.text());
        return Response.redirect(`${st.ret}#discord_error=me`, 302);
      }
      const me = await meRes.json();
      const iat = Date.now();
      const token = await signToken({
        kind: "discord",
        sub: me.id,
        uname: String(me.username || "").toLowerCase(),
        name: me.global_name || me.username,
        avatar: me.avatar || null,
        iat,
        exp: iat + 30 * 24 * 60 * 60 * 1000,
      }, env.AUTH_SECRET);
      return Response.redirect(`${st.ret}#discord=${encodeURIComponent(token)}`, 302);
    }

    if (path === "/discord/me" && method === "GET") {
      const idn = await resolveIdentity(bearer(request), env);
      if (idn.kind !== "discord") return json({ ok: false }, 401);
      return json({ ok: true, discordId: idn.discordId, uname: idn.uname, name: idn.name, avatar: idn.avatar });
    }

    // ── Notion registrations -> team list for the admin setup ──────────────
    // Reads the "CODE Tournament Registrations" database. Requires the
    // NOTION_TOKEN secret (internal integration with access to that DB).
    if (path === "/registrations" && method === "GET") {
      const idn = await resolveIdentity(bearer(request), env);
      if (idn.kind !== "master" && idn.kind !== "account") return json({ ok: false, error: "Unauthorized" }, 401);
      if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) return json({ ok: false, error: "Notion import is not configured yet" }, 503);
      const tournament = url.searchParams.get("tournament") || "";
      const filters = [{ property: "Status", select: { does_not_equal: "Rejected" } }];
      if (tournament) filters.push({ property: "Tournament", select: { equals: tournament } });
      const res = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DB_ID}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: filters.length > 1 ? { and: filters } : filters[0],
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 100,
        }),
      });
      if (!res.ok) {
        console.log("notion query failed", res.status, await res.text());
        return json({ ok: false, error: `Notion API error ${res.status}` }, 502);
      }
      const data = await res.json();
      const text = (p) => ((p && p.rich_text) || []).map((t) => t.plain_text).join("").trim();
      const teams = (data.results || []).map((page) => {
        const pr = page.properties || {};
        const name = ((pr["Team Name"] && pr["Team Name"].title) || []).map((t) => t.plain_text).join("").trim();
        return {
          name,
          players: [text(pr["Player 1 Embark"]), text(pr["Player 2 Embark"]), text(pr["Player 3 Embark"]), text(pr["Sub Embark"])].filter(Boolean),
          discords: [text(pr["Player 1 Discord"]), text(pr["Player 2 Discord"]), text(pr["Player 3 Discord"]), text(pr["Sub Discord"])].filter(Boolean),
          status: (pr["Status"] && pr["Status"].select && pr["Status"].select.name) || "Pending",
          tournament: (pr["Tournament"] && pr["Tournament"].select && pr["Tournament"].select.name) || null,
          submittedAt: page.created_time,
        };
      }).filter((t) => t.name);
      return json({ ok: true, teams });
    }

    // ── Archives: frozen snapshots of finished tournaments ─────────────────
    // Immutable once created (no update route). Public to read, auth to write.
    if (path === "/archives" && method === "GET") {
      const list = await env.OPERATOR_KV.list({ prefix: "archive:" });
      const archives = list.keys.map((k) => {
        const md = k.metadata || {};
        return {
          id: k.name.replace(/^archive:/, ""),
          name: md.name || "Untitled Tournament",
          size: md.size || null,
          mode: md.mode || null,
          champion: md.champion || null,
          host: md.host || null,
          finishedAt: md.finishedAt || null,
        };
      });
      archives.sort((a, b) => Date.parse(b.finishedAt || 0) - Date.parse(a.finishedAt || 0));
      return json({ ok: true, archives });
    }

    if (path === "/archives" && method === "POST") {
      const idn = await resolveIdentity(bearer(request), env);
      if (idn.kind !== "master" && idn.kind !== "account") return json({ ok: false, error: "Unauthorized" }, 401);
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      if (!body.state || typeof body.state !== "string") return json({ ok: false, error: "Missing state" }, 400);
      const id = makeCode("ARC-");
      const meta = {
        name: String(body.name || "Untitled Tournament").slice(0, 80),
        size: body.size ?? null,
        mode: body.mode ?? null,
        champion: body.champion ? String(body.champion).slice(0, 60) : null,
        host: idn.name || null,
        owner: idn.accountId || "operator",
        finishedAt: new Date().toISOString(),
      };
      await env.OPERATOR_KV.put(`archive:${id}`, JSON.stringify({ ...meta, state: body.state }), { metadata: meta });
      return json({ ok: true, id });
    }

    const archMatch = path.match(/^\/archive\/([A-Za-z0-9\-]+)$/);
    if (archMatch) {
      const id = archMatch[1].toUpperCase();
      if (method === "GET") {
        const data = await env.OPERATOR_KV.get(`archive:${id}`);
        if (!data) return json({ ok: false, error: "Archive not found" }, 404);
        return new Response(data, { headers: { "Content-Type": "application/json", ...CORS } });
      }
      if (method === "DELETE") {
        const idn = await resolveIdentity(bearer(request), env);
        const existing = await env.OPERATOR_KV.get(`archive:${id}`, "json");
        if (!existing) return json({ ok: false, error: "Archive not found" }, 404);
        if (!(idn.kind === "master" || (idn.kind === "account" && existing.owner === idn.accountId))) {
          return json({ ok: false, error: "Unauthorized" }, 401);
        }
        await env.OPERATOR_KV.delete(`archive:${id}`);
        return json({ ok: true });
      }
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    // ── Bot: apply a verified match result (screenshot pipeline) ───────────
    // Auth via shared secret; the DO applies placements and re-propagates.
    if (path === "/bot/result" && method === "POST") {
      if (!env.BOT_SECRET || request.headers.get("X-Bot-Secret") !== env.BOT_SECRET) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      const code = String(body.code || "").toUpperCase();
      if (!code || !body.podId || !body.placements) return json({ ok: false, error: "code, podId, placements required" }, 400);
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(code));
      return stub.fetch(new Request(`https://do/session/${code}/bot-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ podId: body.podId, placements: body.placements, editor: body.editor }),
      }));
    }

    // ── Bot: set a match's map (outcome of the Discord map-ban phase) ──────
    if (path === "/bot/map" && method === "POST") {
      if (!env.BOT_SECRET || request.headers.get("X-Bot-Secret") !== env.BOT_SECRET) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      const code = String(body.code || "").toUpperCase();
      if (!code || !body.podId || !body.map) return json({ ok: false, error: "code, podId, map required" }, 400);
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(code));
      return stub.fetch(new Request(`https://do/session/${code}/bot-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ podId: body.podId, map: body.map, editor: body.editor }),
      }));
    }

    // ── Session routes -> Durable Object ───────────────────────────────────
    const m = path.match(/^\/session\/([A-Za-z0-9\-]+)(\/ws|\/owner)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(code));
      return stub.fetch(request);
    }

    // ── Published bracket snapshot (KV) ────────────────────────────────────
    if (path === "/bracket") {
      if (method === "GET") {
        const data = await env.OPERATOR_KV.get("active-bracket");
        if (!data) return json({ ok: false, error: "No active bracket" }, 404);
        return new Response(data, { headers: { "Content-Type": "application/json", ...CORS } });
      }
      const idn = await resolveIdentity(bearer(request), env);
      if (idn.kind === "none") return json({ ok: false, error: "Unauthorized" }, 401);
      if (method === "POST") { const body = await request.json(); await env.OPERATOR_KV.put("active-bracket", body.state); return json({ ok: true }); }
      if (method === "DELETE") { await env.OPERATOR_KV.delete("active-bracket"); return json({ ok: true }); }
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

export class SessionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.lastKvWrite = 0;
    try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch { /* older runtime */ }
  }

  async loadDoc() {
    if (this._loaded) return;
    this._doc = (await this.state.storage.get("doc")) || null;
    this._code = (await this.state.storage.get("code")) || null;
    this._loaded = true;
  }
  async saveDoc(doc) { this._doc = doc; await this.state.storage.put("doc", doc); }
  async ensureCode(code) { if (code && this._code !== code) { this._code = code; await this.state.storage.put("code", code); } }

  broadcast() {
    if (!this._doc) return;
    const msg = JSON.stringify({ t: "state", state: this._doc.state, version: this._doc.version, lastEditor: this._doc.lastEditor });
    for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch { /* ignore */ } }
  }

  async maybeIndex() {
    const now = Date.now();
    if (this._code && this._doc && now - this.lastKvWrite > 10000) {
      this.lastKvWrite = now;
      const d = this._doc;
      try {
        await this.env.OPERATOR_KV.put(`room:${this._code}`, "1", {
          metadata: { name: d.name, size: d.size, mode: d.mode, host: d.lastEditor, owner: d.owner || null, updatedAt: d.updatedAt },
          expirationTtl: ACTIVE_WINDOW_MS / 1000,
        });
      } catch { /* best effort */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const parts = url.pathname.split("/"); // ["", "session", CODE, "ws"|"owner"?]
    const code = (parts[2] || "").toUpperCase();
    const tail = parts[3];

    await this.loadDoc();
    await this.ensureCode(code);

    // Internal: report current owner (used by /share authorization).
    if (tail === "owner") return json({ ok: true, owner: this._doc ? (this._doc.owner || null) : null });

    // Internal: map decided by the Discord ban phase. Reached only via the
    // worker's /bot/map route.
    if (tail === "bot-map" && method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      if (!this._doc) return json({ ok: false, error: "Session not found" }, 404);
      let s; try { s = JSON.parse(this._doc.state); } catch { return json({ ok: false, error: "Bad state" }, 500); }
      const pod = (s.pods || []).find((p) => p.id === body.podId);
      if (!pod) return json({ ok: false, error: "Pod not found" }, 404);
      pod.map = String(body.map).slice(0, 40);
      await this.saveDoc({
        ...this._doc,
        state: JSON.stringify(s),
        version: this._doc.version + 1,
        lastEditor: body.editor || "Map Ban Bot",
        updatedAt: new Date().toISOString(),
      });
      this.broadcast();
      await this.maybeIndex();
      return json({ ok: true, version: this._doc.version, map: pod.map });
    }

    // Internal: bot-verified match result. Reached only via the worker's
    // /bot/result route (public /session/:code router never forwards this tail).
    if (tail === "bot-result" && method === "POST") {
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      if (!this._doc) return json({ ok: false, error: "Session not found" }, 404);
      let s; try { s = JSON.parse(this._doc.state); } catch { return json({ ok: false, error: "Bad state" }, 500); }
      const pod = (s.pods || []).find((p) => p.id === body.podId);
      if (!pod) return json({ ok: false, error: "Pod not found" }, 404);
      for (const [teamName, place] of Object.entries(body.placements || {})) {
        const idx = pod.teams.findIndex((t) => t.name === teamName);
        if (idx === -1) return json({ ok: false, error: `Team not in this match: ${teamName}` }, 400);
        pod.teams[idx].placement = Number(place) || 0;
      }
      const opts = { finalsBracket: !!s.finalsBracket };
      const cfg = resolveConfig(s.tournamentSize, s.tournamentMode, s.globalFormat, s.formatConfig || {}, opts);
      s.pods = propagate(s.pods, s.tournamentSize, s.tournamentMode, cfg, opts);
      await this.saveDoc({
        ...this._doc,
        state: JSON.stringify(s),
        version: this._doc.version + 1,
        lastEditor: body.editor || "Result Bot",
        updatedAt: new Date().toISOString(),
      });
      this.broadcast();
      await this.maybeIndex();
      return json({ ok: true, version: this._doc.version });
    }

    if (tail === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const idn = await resolveIdentity(url.searchParams.get("token"), this.env);
      const owner = this._doc ? (this._doc.owner || null) : null;
      const write = canWrite(idn, owner, code);
      const editor = url.searchParams.get("editor") || idn.name || "Spectator";

      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({
        canWrite: write, editor, code, accountId: idn.accountId || null, idnKind: idn.kind,
        discordId: idn.kind === "discord" ? idn.discordId : null,
        uname: idn.kind === "discord" ? idn.uname : null,
        dname: idn.kind === "discord" ? idn.name : null,
        avatar: idn.kind === "discord" ? (idn.avatar || null) : null,
      });

      if (this._doc) server.send(JSON.stringify({ t: "state", state: this._doc.state, version: this._doc.version, lastEditor: this._doc.lastEditor }));
      else server.send(JSON.stringify({ t: "empty" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (method === "GET") {
      if (!this._doc) return json({ ok: false, error: "Session not found" }, 404);
      const d = this._doc;
      return json({ ok: true, state: d.state, version: d.version, lastEditor: d.lastEditor, name: d.name, size: d.size, mode: d.mode, owner: d.owner || null, updatedAt: d.updatedAt });
    }

    if (method === "PUT") {
      const idn = await resolveIdentity(request.headers.get("X-Admin-Token"), this.env);
      const owner = this._doc ? (this._doc.owner || null) : null;
      if (!canWrite(idn, owner, code)) return json({ ok: false, error: "Unauthorized" }, 401);
      let body; try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      await this.applyFullState(body.state, { editor: body.editor, name: body.name, size: body.size, mode: body.mode }, ownerToSet(idn, owner));
      this.broadcast();
      await this.maybeIndex();
      const d = this._doc;
      return json({ ok: true, version: d.version, lastEditor: d.lastEditor, name: d.name, updatedAt: d.updatedAt });
    }

    if (method === "DELETE") {
      const idn = await resolveIdentity(request.headers.get("X-Admin-Token"), this.env);
      const owner = this._doc ? (this._doc.owner || null) : null;
      if (!canWrite(idn, owner, code)) return json({ ok: false, error: "Unauthorized" }, 401);
      await this.state.storage.deleteAll();
      this._doc = null;
      try { await this.env.OPERATOR_KV.delete(`room:${code}`); } catch { /* ignore */ }
      for (const ws of this.state.getWebSockets()) { try { ws.close(1000, "deleted"); } catch { /* ignore */ } }
      return json({ ok: true });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  async applyFullState(stateStr, meta, owner) {
    const prev = this._doc;
    const doc = {
      state: stateStr,
      version: ((prev && prev.version) || 0) + 1,
      lastEditor: (meta && meta.editor) || (prev && prev.lastEditor) || "Unknown",
      name: (meta && meta.name) || (prev && prev.name) || "Untitled Tournament",
      size: (meta && meta.size) ?? (prev && prev.size) ?? null,
      mode: (meta && meta.mode) ?? (prev && prev.mode) ?? null,
      owner: owner ?? (prev && prev.owner) ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.saveDoc(doc);
  }

  async applyMutation(mut, editor) {
    if (!this._doc) return false;
    let s;
    try { s = JSON.parse(this._doc.state); } catch { return false; }
    if (!s || !Array.isArray(s.pods)) return false;
    const pod = s.pods.find((p) => p.id === mut.podId);
    if (!pod) return false;

    if (mut.t === "set-placement") {
      if (pod.teams[mut.teamIdx]) pod.teams[mut.teamIdx].placement = mut.placement;
      const opts = { finalsBracket: !!s.finalsBracket };
      const cfg = resolveConfig(s.tournamentSize, s.tournamentMode, s.globalFormat, s.formatConfig || {}, opts);
      s.pods = propagate(s.pods, s.tournamentSize, s.tournamentMode, cfg, opts);
    } else if (mut.t === "set-map") {
      pod.map = mut.map;
    } else if (mut.t === "set-stream") {
      if (mut.liveNow) { for (const p of s.pods) p.liveNow = false; }
      pod.onStream = !!mut.onStream;
      pod.liveNow = !!mut.liveNow;
    } else {
      return false;
    }

    await this.saveDoc({
      ...this._doc,
      state: JSON.stringify(s),
      version: this._doc.version + 1,
      lastEditor: editor || this._doc.lastEditor,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  // ─── Match chat (private: block participants + admins only) ───────────────
  parseStateDoc() {
    if (!this._doc) return null;
    try { return JSON.parse(this._doc.state); } catch { return null; }
  }

  // Pod ids this attachment may chat in. Admin-ish sockets (canWrite) see all.
  chatPods(att, s) {
    if (att.canWrite) return "all";
    if (!att.uname && !att.discordId) return new Set();
    if (!s || !Array.isArray(s.pods)) return new Set();
    const teamNames = new Set();
    for (const seed of (s.seeds || [])) {
      const list = seed.discords || [];
      const hit = list.some((d) => normDiscord(d) === att.uname || String(d).trim() === att.discordId);
      if (hit && seed.name) teamNames.add(seed.name);
    }
    const pods = new Set();
    if (teamNames.size === 0) return pods;
    for (const p of s.pods) {
      if (!p.teams || !p.teams.some((t) => t.name && teamNames.has(t.name))) continue;
      // A fully resolved match (every slot filled and placed) is archived for
      // players — its teams have moved on. Admins keep access via "all".
      const finished = p.teams.length >= 2 && p.teams.every((t) => t.name && t.placement !== 0);
      if (finished) continue;
      pods.add(p.id);
    }
    return pods;
  }

  chatAllowed(att, podId, s) {
    const pods = this.chatPods(att, s);
    return pods === "all" || pods.has(podId);
  }

  async chatHistory(podId) {
    return (await this.state.storage.get(`chat:${podId}`)) || [];
  }

  broadcastChat(podId, payload) {
    const s = this.parseStateDoc();
    const msg = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        const att = (ws.deserializeAttachment && ws.deserializeAttachment()) || {};
        if (this.chatAllowed(att, podId, s)) ws.send(msg);
      } catch { /* ignore */ }
    }
  }

  async handleChatMessage(ws, att, data) {
    const s = this.parseStateDoc();

    if (data.t === "chat-access") {
      const pods = this.chatPods(att, s);
      ws.send(JSON.stringify({ t: "chat-access", admin: pods === "all", pods: pods === "all" ? [] : [...pods] }));
      return;
    }

    const podId = String(data.podId || "");
    if (!podId || !this.chatAllowed(att, podId, s)) {
      ws.send(JSON.stringify({ t: "chat-denied", podId }));
      return;
    }

    if (data.t === "chat-open") {
      const messages = await this.chatHistory(podId);
      ws.send(JSON.stringify({ t: "chat-history", podId, messages }));
      return;
    }

    if (data.t === "chat-send") {
      const text = String(data.text || "").trim().slice(0, 400);
      if (!text) return;
      // Light rate limit: 1 message per 700ms per socket.
      this._lastChatAt = this._lastChatAt || new Map();
      const last = this._lastChatAt.get(ws) || 0;
      const now = Date.now();
      if (now - last < 700) return;
      this._lastChatAt.set(ws, now);
      const isAdmin = !!att.canWrite;
      const msg = {
        id: b64url(randBytes(9)),
        ts: now,
        text,
        name: isAdmin ? (att.editor || "Admin") : (att.dname || att.uname || "Player"),
        uname: att.uname || null,
        uid: att.discordId || null,
        avatar: att.avatar || null,
        admin: isAdmin,
      };
      if (typeof data.nonce === "string" && data.nonce) msg.nonce = data.nonce.slice(0, 40);
      const list = await this.chatHistory(podId);
      list.push(msg);
      while (list.length > 300) list.shift();
      await this.state.storage.put(`chat:${podId}`, list);
      this.broadcastChat(podId, { t: "chat-msg", podId, msg });
      return;
    }

    if (data.t === "chat-delete") {
      if (!att.canWrite) { ws.send(JSON.stringify({ t: "chat-denied", podId })); return; }
      const msgId = String(data.msgId || "");
      const list = await this.chatHistory(podId);
      const idx = list.findIndex((m) => m.id === msgId);
      if (idx !== -1 && !list[idx].del) {
        // Tombstone instead of removal: viewers see "Deleted by admin".
        list[idx] = { id: list[idx].id, ts: list[idx].ts, del: true };
        await this.state.storage.put(`chat:${podId}`, list);
        this.broadcastChat(podId, { t: "chat-del", podId, msgId });
      }
      return;
    }
  }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const att = (ws.deserializeAttachment && ws.deserializeAttachment()) || {};
    await this.loadDoc();

    if (data.t === "hello") return;
    // Chat runs before the read-only guard: participants can chat but not edit the bracket.
    if (data.t === "chat-access" || data.t === "chat-open" || data.t === "chat-send" || data.t === "chat-delete") {
      try { await this.handleChatMessage(ws, att, data); } catch { /* ignore */ }
      return;
    }
    if (!att.canWrite) { try { ws.send(JSON.stringify({ t: "error", error: "read-only" })); } catch { /* ignore */ } return; }
    await this.ensureCode(att.code);

    if (data.t === "full-state") {
      const owner = this._doc ? (this._doc.owner || null) : null;
      const setOwner = owner ?? (att.idnKind === "account" ? att.accountId : "operator");
      await this.applyFullState(data.state, { editor: att.editor, name: data.name, size: data.size, mode: data.mode }, setOwner);
      this.broadcast();
      await this.maybeIndex();
    } else if (data.t === "set-placement" || data.t === "set-map" || data.t === "set-stream") {
      const ok = await this.applyMutation(data, att.editor);
      if (ok) { this.broadcast(); await this.maybeIndex(); }
    }
  }

  async webSocketClose() { /* nothing */ }
  async webSocketError() { /* nothing */ }
}

// Mirror of the client's resolveConfig so the DO can propagate authoritatively.
function resolveConfig(size, mode, globalFormat, overrides, opts) {
  const graph = getPhaseGraph(size, mode, opts);
  const cfg = {};
  for (const ph of graph) {
    if (ph.id === "gf") { cfg[ph.id] = 2; continue; }
    cfg[ph.id] = (overrides && overrides[ph.id]) ?? globalFormat;
  }
  return cfg;
}
