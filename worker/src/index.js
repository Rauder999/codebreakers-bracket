// ============================================================================
// Codebreakers operator API — Phase 1a (Durable-Object-backed sessions)
// ----------------------------------------------------------------------------
// Live session state now lives in a Durable Object (strongly consistent, no
// 60s KV read cache) instead of KV. HTTP endpoints are unchanged, so the
// existing admin/live frontend works against this worker by only swapping
// WORKER_URL. WebSocket push is added in Phase 1b.
//
//   GET    /session/:code            -> current state (from the DO)
//   PUT    /session/:code            -> apply edit (admin token)         [DO]
//   DELETE /session/:code            -> delete session (admin token)     [DO]
//   GET    /sessions/active          -> list of active tournaments       [KV index]
//   GET/POST/DELETE /bracket         -> published spectator snapshot      [KV]
// ============================================================================

const ADMIN_TOKEN = "operator-2026-pasha";
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ── Active sessions list (KV index; metadata only) ──────────────────────
    if (path === "/sessions/active" && method === "GET") {
      const list = await env.OPERATOR_KV.list({ prefix: "room:" });
      const now = Date.now();
      const active = [];
      for (const k of list.keys) {
        const md = k.metadata || {};
        const updated = md.updatedAt ? Date.parse(md.updatedAt) : 0;
        if (now - updated <= ACTIVE_WINDOW_MS) {
          active.push({
            code: k.name.replace(/^room:/, ""),
            name: md.name || "Untitled Tournament",
            size: md.size || null,
            mode: md.mode || null,
            host: md.host || null,
            updatedAt: md.updatedAt || null,
          });
        }
      }
      active.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
      return json({ ok: true, sessions: active });
    }

    // ── Session routes -> Durable Object (one instance per code) ────────────
    const m = path.match(/^\/session\/([A-Za-z0-9\-]+)$/);
    if (m) {
      const code = m[1].toUpperCase();
      const id = env.SESSION_ROOM.idFromName(code);
      const stub = env.SESSION_ROOM.get(id);
      return stub.fetch(request);
    }

    // ── Published bracket snapshot (KV) for spectators ──────────────────────
    if (path === "/bracket") {
      if (method === "GET") {
        const data = await env.OPERATOR_KV.get("active-bracket");
        if (!data) return json({ ok: false, error: "No active bracket" }, 404);
        return new Response(data, { headers: { "Content-Type": "application/json", ...CORS } });
      }
      if (method === "POST") {
        if (request.headers.get("X-Admin-Token") !== ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
        const body = await request.json();
        await env.OPERATOR_KV.put("active-bracket", body.state);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        if (request.headers.get("X-Admin-Token") !== ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
        await env.OPERATOR_KV.delete("active-bracket");
        return json({ ok: true });
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

// ── Durable Object: one live session room ─────────────────────────────────
export class SessionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const code = (url.pathname.split("/")[2] || "").toUpperCase();

    const meta = (await this.state.storage.get("meta")) || null;
    const stateStr = (await this.state.storage.get("state"));

    if (method === "GET") {
      if (stateStr == null) return json({ ok: false, error: "Session not found" }, 404);
      return json({
        ok: true,
        state: stateStr,
        version: meta.version,
        lastEditor: meta.lastEditor,
        name: meta.name,
        size: meta.size,
        mode: meta.mode,
        updatedAt: meta.updatedAt,
      });
    }

    if (method === "PUT") {
      if (request.headers.get("X-Admin-Token") !== ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }

      const updatedAt = new Date().toISOString();
      const next = {
        version: ((meta && meta.version) || 0) + 1,
        lastEditor: body.editor || "Unknown",
        name: body.name || (meta && meta.name) || "Untitled Tournament",
        size: body.size ?? (meta && meta.size) ?? null,
        mode: body.mode ?? (meta && meta.mode) ?? null,
        updatedAt,
      };
      await this.state.storage.put("meta", next);
      await this.state.storage.put("state", body.state);

      // Maintain the KV index so /sessions/active keeps working.
      try {
        await this.env.OPERATOR_KV.put(`room:${code}`, "1", {
          metadata: { name: next.name, size: next.size, mode: next.mode, host: next.lastEditor, updatedAt },
          expirationTtl: ACTIVE_WINDOW_MS / 1000,
        });
      } catch { /* index is best-effort */ }

      return json({ ok: true, version: next.version, lastEditor: next.lastEditor, name: next.name, updatedAt });
    }

    if (method === "DELETE") {
      if (request.headers.get("X-Admin-Token") !== ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
      await this.state.storage.deleteAll();
      try { await this.env.OPERATOR_KV.delete(`room:${code}`); } catch { /* ignore */ }
      return json({ ok: true });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  }
}
