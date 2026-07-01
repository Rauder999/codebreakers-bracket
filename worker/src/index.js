// ============================================================================
// Codebreakers operator API — Phase 1b
// ----------------------------------------------------------------------------
// Durable-Object-backed live sessions with:
//   • WebSocket push (hibernatable) for sub-second, two-way sync
//   • Semantic per-match mutations (set-placement / set-map / set-stream) that
//     the DO applies on top of its authoritative state and re-propagates — so
//     two operators editing DIFFERENT matches never overwrite each other
//   • Full-state path for structural changes (generate / reset / format)
//   • Backwards-compatible HTTP endpoints (GET/PUT/DELETE /session/:code,
//     /sessions/active, /bracket) so older clients keep working
//
// Auth in this phase is still the single ADMIN_TOKEN (Phase 2 swaps this for
// per-organizer accounts).
// ============================================================================

import { propagate, getPhaseGraph } from "../../client/src/lib/bracketEngine";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

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

    // /session/:code  and  /session/:code/ws  -> Durable Object
    const m = path.match(/^\/session\/([A-Za-z0-9\-]+)(\/ws)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      const id = env.SESSION_ROOM.idFromName(code);
      return env.SESSION_ROOM.get(id).fetch(request);
    }

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

export class SessionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.lastKvWrite = 0;
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    } catch { /* older runtime */ }
  }

  async loadDoc() {
    if (this._loaded) return;
    this._doc = (await this.state.storage.get("doc")) || null;
    this._code = (await this.state.storage.get("code")) || null;
    this._loaded = true;
  }

  async saveDoc(doc) {
    this._doc = doc;
    await this.state.storage.put("doc", doc);
  }

  async ensureCode(code) {
    if (code && this._code !== code) {
      this._code = code;
      await this.state.storage.put("code", code);
    }
  }

  broadcast() {
    if (!this._doc) return;
    const msg = JSON.stringify({ t: "state", state: this._doc.state, version: this._doc.version, lastEditor: this._doc.lastEditor });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* ignore closed */ }
    }
  }

  async maybeIndex() {
    const now = Date.now();
    if (this._code && this._doc && now - this.lastKvWrite > 10000) {
      this.lastKvWrite = now;
      const d = this._doc;
      try {
        await this.env.OPERATOR_KV.put(`room:${this._code}`, "1", {
          metadata: { name: d.name, size: d.size, mode: d.mode, host: d.lastEditor, updatedAt: d.updatedAt },
          expirationTtl: ACTIVE_WINDOW_MS / 1000,
        });
      } catch { /* best effort */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const parts = url.pathname.split("/"); // ["", "session", CODE, "ws"?]
    const code = (parts[2] || "").toUpperCase();
    const isWs = parts[3] === "ws";

    await this.loadDoc();
    await this.ensureCode(code);

    if (isWs) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const token = url.searchParams.get("token") || "";
      const editor = url.searchParams.get("editor") || "Spectator";
      const canWrite = token === ADMIN_TOKEN;

      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ canWrite, editor, code });

      if (this._doc) {
        server.send(JSON.stringify({ t: "state", state: this._doc.state, version: this._doc.version, lastEditor: this._doc.lastEditor }));
      } else {
        server.send(JSON.stringify({ t: "empty" }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (method === "GET") {
      if (!this._doc) return json({ ok: false, error: "Session not found" }, 404);
      const d = this._doc;
      return json({ ok: true, state: d.state, version: d.version, lastEditor: d.lastEditor, name: d.name, size: d.size, mode: d.mode, updatedAt: d.updatedAt });
    }

    if (method === "PUT") {
      if (request.headers.get("X-Admin-Token") !== ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
      await this.applyFullState(body.state, body);
      this.broadcast();
      await this.maybeIndex();
      const d = this._doc;
      return json({ ok: true, version: d.version, lastEditor: d.lastEditor, name: d.name, updatedAt: d.updatedAt });
    }

    if (method === "DELETE") {
      if (request.headers.get("X-Admin-Token") !== ADMIN_TOKEN) return json({ ok: false, error: "Unauthorized" }, 401);
      await this.state.storage.deleteAll();
      this._doc = null;
      try { await this.env.OPERATOR_KV.delete(`room:${code}`); } catch { /* ignore */ }
      for (const ws of this.state.getWebSockets()) { try { ws.close(1000, "deleted"); } catch { /* ignore */ } }
      return json({ ok: true });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  // Replace the whole session document (structural changes: generate/reset/format).
  async applyFullState(stateStr, meta) {
    const prev = this._doc;
    const doc = {
      state: stateStr,
      version: ((prev && prev.version) || 0) + 1,
      lastEditor: (meta && meta.editor) || (prev && prev.lastEditor) || "Unknown",
      name: (meta && meta.name) || (prev && prev.name) || "Untitled Tournament",
      size: (meta && meta.size) ?? (prev && prev.size) ?? null,
      mode: (meta && meta.mode) ?? (prev && prev.mode) ?? null,
      updatedAt: new Date().toISOString(),
    };
    await this.saveDoc(doc);
  }

  // Apply a single semantic mutation to the authoritative state and re-propagate.
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

  // ── Hibernatable WebSocket handlers ──────────────────────────────────────
  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const att = (ws.deserializeAttachment && ws.deserializeAttachment()) || {};
    await this.loadDoc();

    if (data.t === "hello") return; // attachment already set at accept

    if (!att.canWrite) {
      try { ws.send(JSON.stringify({ t: "error", error: "read-only" })); } catch { /* ignore */ }
      return;
    }
    await this.ensureCode(att.code);

    if (data.t === "full-state") {
      await this.applyFullState(data.state, { editor: att.editor, name: data.name, size: data.size, mode: data.mode });
      this.broadcast();
      await this.maybeIndex();
    } else if (data.t === "set-placement" || data.t === "set-map" || data.t === "set-stream") {
      const ok = await this.applyMutation(data, att.editor);
      if (ok) { this.broadcast(); await this.maybeIndex(); }
    }
  }

  async webSocketClose() { /* nothing to clean up */ }
  async webSocketError() { /* nothing */ }
}
