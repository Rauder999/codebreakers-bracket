/*
 * DESIGN: Cold Steel - Industrial Precision
 * Dark terminal, 1px borders, no rounding, Saira Condensed
 * Silver + Purple signals, Green = advance, Orange = LB/drop, Gold = champion
 *
 * ENGINE: bracketEngine.ts - generative, per-phase format (2 or 4 teams)
 * MODES: Single Elimination / Double Elimination
 * FEATURES: per-stage format toggle, map plates, CSV import
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import html2canvas from "html2canvas";
import {
  buildInitialPods,
  propagate,
  getPhaseGraph,
  getPhaseOrder,
  effectivePodSize,
  type Pod,
  type TeamSlot,
  type SeedEntry,
  type TournamentMode,
  type FormatConfig,
  type PodSize,
  type Size,
  type EngineOptions,
} from "../lib/bracketEngine";

// ─── Map data ─────────────────────────────────────────────────────────────────

const MAP_NAMES = [
  "Bernal", "Fangwai City", "Fortune Stadium", "Las Vegas Stadium",
  "Monaco", "Nozomi/Citadel", "Skyway Stadium", "Sys$Horizon",
];

// ─── Persistence helpers ──────────────────────────────────────────────────────

const AUTOSAVE_KEY = "cb_autosave";
const SAVES_KEY = "cb_saves";

interface SavedTournament {
  id: string;
  name: string;
  savedAt: number;
  screen: "setup" | "bracket";
  tournamentSize: Size;
  tournamentMode: TournamentMode;
  seeds: SeedEntry[];
  pods: Pod[];
  formatConfig?: FormatConfig;
  globalFormat?: PodSize;
  finalsBracket?: boolean;
}

function loadSaves(): SavedTournament[] {
  try { return JSON.parse(localStorage.getItem(SAVES_KEY) || "[]"); } catch { return []; }
}

function persistSaves(saves: SavedTournament[]) {
  localStorage.setItem(SAVES_KEY, JSON.stringify(saves));
}

function loadAutosave(): Partial<SavedTournament> | null {
  try { const raw = localStorage.getItem(AUTOSAVE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ─── Constants ────────────────────────────────────────────────────────────────

type Placement = 0 | 1 | 2 | 3 | 4;
const PLACEMENT_LABELS: Record<Placement, string> = { 0: "-", 1: "1st", 2: "2nd", 3: "3rd", 4: "4th" };
const PLACEMENT_EMOJIS: Record<Placement, string> = { 0: "", 1: "🥇", 2: "🥈", 3: "🥉", 4: "" };

interface Connector {
  x1: number; y1: number;
  x2: number; y2: number;
  x2R: number; // dest row RIGHT edge, used when the corridor sits right of the dest
  channelX: number; // vertical corridor X for orthogonal routing
  key: string;
  active: boolean;
  isDrop?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultSeeds(size: number): SeedEntry[] {
  return Array.from({ length: size }, (_, i) => ({ name: `Team ${i + 1}`, seed: i + 1, players: [] }));
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resolveConfig(size: Size, mode: TournamentMode, globalFormat: PodSize, overrides: FormatConfig, opts?: EngineOptions): FormatConfig {
  const graph = getPhaseGraph(size, mode, opts);
  const cfg: FormatConfig = {};
  for (const ph of graph) {
    if (ph.id === "gf") { cfg[ph.id] = 2; continue; }
    cfg[ph.id] = overrides[ph.id] ?? globalFormat;
  }
  return cfg;
}

function groupPodsByPhase(pods: Pod[], mode: TournamentMode, size: Size, opts?: EngineOptions): {
  phase: string; label: string; pods: Pod[]; bracket?: "wb" | "lb" | "gf"
}[] {
  const phaseOrder = getPhaseOrder(size, mode, opts);
  const graph = getPhaseGraph(size, mode, opts);
  const labelMap = new Map(graph.map((p) => [p.id, p.label]));
  const map = new Map<string, Pod[]>();
  for (const p of pods) {
    if (!map.has(p.phase)) map.set(p.phase, []);
    map.get(p.phase)!.push(p);
  }
  return phaseOrder
    .filter((ph) => map.has(ph))
    .map((ph) => ({
      phase: ph,
      label: labelMap.get(ph) || ph.toUpperCase(),
      pods: map.get(ph)!,
      bracket: map.get(ph)![0]?.bracket,
    }));
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

function seedsFromImport(
  rows: string[][], nameCol: number, strengthCol: number, playerCols: number[], size: Size
): SeedEntry[] {
  const teams = rows.slice(1).map(r => ({
    name: (r[nameCol] || "").trim(),
    strength: parseFloat(r[strengthCol]) || 0,
    players: playerCols.map(c => (r[c] || "").trim()).filter(Boolean),
  })).filter(t => t.name);
  teams.sort((a, b) => b.strength - a.strength);
  const result = teams.slice(0, size).map((t, i) => ({ name: t.name, seed: i + 1, players: t.players }));
  if (teams.length < size) {
    const pad = size - teams.length;
    for (let i = 0; i < pad; i++) result.push({ name: `TBD ${i + 1}`, seed: result.length + 1, players: [] });
    toast.warning(`Only ${teams.length} teams found - padded ${pad} TBD slots`);
  } else if (teams.length > size) {
    toast.warning(`${teams.length} teams found - top ${size} by strength selected`);
  }
  return result;
}

// ─── Main Component ───────────────────────────────────────────────────────────

const LOGO_URL = "./CODE_LOGO.png";

interface OngoingSession {
  code: string;
  name: string;
  size: number | null;
  mode: string | null;
  host: string | null;
  updatedAt: string | null;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Home() {
  const _as = loadAutosave();
  const [screen, setScreen] = useState<"setup" | "bracket">(_as?.screen ?? "setup");
  const [tournamentSize, setTournamentSize] = useState<Size>(_as?.tournamentSize ?? 16);
  const [tournamentMode, setTournamentMode] = useState<TournamentMode>(_as?.tournamentMode ?? "single");
  const [seeds, setSeeds] = useState<SeedEntry[]>(_as?.seeds ?? defaultSeeds(16));
  const [pods, setPods] = useState<Pod[]>(_as?.pods ?? []);
  const [screenshotMode, setScreenshotMode] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  // Format config
  const [formatConfig, setFormatConfig] = useState<FormatConfig>(_as?.formatConfig ?? {});
  const [globalFormat, setGlobalFormat] = useState<PodSize>(_as?.globalFormat ?? 4);
  const [finalsBracket, setFinalsBracket] = useState<boolean>(_as?.finalsBracket ?? false);
  const engineOpts = useMemo(() => ({ finalsBracket }), [finalsBracket]);

  // Map picker
  const [mapPickerPod, setMapPickerPod] = useState<string | null>(null);

  // CSV import state
  const [showCsvPanel, setShowCsvPanel] = useState(false);
  const [csvUrl, setCsvUrl] = useState("");
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvNameCol, setCsvNameCol] = useState(0);
  const [csvStrengthCol, setCsvStrengthCol] = useState(1);
  const [csvPlayerCols, setCsvPlayerCols] = useState<number[]>([]);
  const csvFileRef = useRef<HTMLInputElement>(null);

  // Undo / Redo
  const undoStack = useRef<Pod[][]>([]);
  const redoStack = useRef<Pod[][]>([]);
  const MAX_HISTORY = 50;

  // Save slots
  const [saves, setSaves] = useState<SavedTournament[]>(() => loadSaves());
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  // Publish
  const WORKER_URL = "https://operator-api-rt.taksatovq.workers.dev";
  const WS_URL = WORKER_URL.replace(/^http/, "ws");
  const [isLive, setIsLive] = useState(false);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing" | "ok" | "error">("idle");
  const [autoPublish, setAutoPublish] = useState(false);
  const autoPublishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adminToken, setAdminToken] = useState<string>(() => sessionStorage.getItem("cb_admin_token") || "");
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState("");
  const pendingAction = useRef<"publish" | "unpublish" | "generate-session" | "delete-session" | null>(null);
  const pendingGenState = useRef<string | null>(null);
  const pendingDeleteCode = useRef<string | null>(null);
  const [ongoingSessions, setOngoingSessions] = useState<OngoingSession[]>([]);
  const [showOngoing, setShowOngoing] = useState(false);
  const [ongoingLoading, setOngoingLoading] = useState(false);

  // Session
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [editorName, setEditorName] = useState(() => localStorage.getItem("cb_editor") || "");
  const [lastEditor, setLastEditor] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "conflict">("idle");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [showSessionPanel, setShowSessionPanel] = useState(false);
  const [tournamentName, setTournamentName] = useState(() => sessionStorage.getItem("cb_session_name") || "");
  const tournamentNameRef = useRef(tournamentName);
  const sessionPutInFlight = useRef(false);
  const sessionPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsOutbox = useRef<string[]>([]);
  const wsReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendMutation = useCallback((mut: Record<string, unknown>) => {
    const msg = JSON.stringify(mut);
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) { try { ws.send(msg); return; } catch { /* fall through to buffer */ } }
    wsOutbox.current.push(msg); // flushed when the socket (re)connects
  }, []);
  const sessionVersionRef = useRef(0);
  const sessionCodeRef = useRef<string | null>(null);
  const myVersionRef = useRef(0);
  const editorNameRef = useRef(editorName);
  const adoptingRef = useRef(false); // true while applying server state, to suppress echo-PUT
  // Keep editorNameRef and tournamentNameRef in sync
  useEffect(() => { editorNameRef.current = editorName; }, [editorName]);
  useEffect(() => { tournamentNameRef.current = tournamentName; }, [tournamentName]);

  // Team list

  // Autosave
  useEffect(() => {
    const data: Partial<SavedTournament> = { screen, tournamentSize, tournamentMode, seeds, pods, formatConfig, globalFormat, finalsBracket };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
  }, [screen, tournamentSize, tournamentMode, seeds, pods, formatConfig, globalFormat, finalsBracket]);

  // Undo/redo
  const setPodsWithHistory = useCallback((updater: Pod[] | ((prev: Pod[]) => Pod[])) => {
    setPods((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      undoStack.current = [...undoStack.current.slice(-MAX_HISTORY + 1), prev];
      redoStack.current = [];
      return next;
    });
  }, []);

  const handleUndo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current[undoStack.current.length - 1];
    undoStack.current = undoStack.current.slice(0, -1);
    setPods((cur) => { redoStack.current = [...redoStack.current, cur]; return prev; });
    toast("Undo", { description: "Last action undone", duration: 1500 });
  }, []);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current[redoStack.current.length - 1];
    redoStack.current = redoStack.current.slice(0, -1);
    setPods((cur) => { undoStack.current = [...undoStack.current, cur]; return next; });
    toast("Redo", { description: "Action re-applied", duration: 1500 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") { e.preventDefault(); handleUndo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleUndo, handleRedo]);

  // Save/load/export/import
  const handleSaveTournament = useCallback(() => {
    const name = saveNameInput.trim() || `Tournament ${new Date().toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
    const entry: SavedTournament = { id: Date.now().toString(), name, savedAt: Date.now(), screen, tournamentSize, tournamentMode, seeds, pods, formatConfig, globalFormat, finalsBracket };
    const updated = [entry, ...saves].slice(0, 10);
    setSaves(updated);
    persistSaves(updated);
    setSaveNameInput("");
    setShowSavePanel(false);
    toast("Saved!", { description: `"${name}" saved`, duration: 2000 });
  }, [saveNameInput, screen, tournamentSize, tournamentMode, seeds, pods, saves, formatConfig, globalFormat]);

  const handleLoadTournament = useCallback((save: SavedTournament) => {
    setScreen(save.screen);
    setTournamentSize(save.tournamentSize);
    setTournamentMode(save.tournamentMode);
    setSeeds(save.seeds);
    setPods(save.pods);
    if (save.formatConfig) setFormatConfig(save.formatConfig);
    if (save.globalFormat) setGlobalFormat(save.globalFormat);
    if (save.finalsBracket !== undefined) setFinalsBracket(save.finalsBracket);
    undoStack.current = [];
    redoStack.current = [];
    setShowSavePanel(false);
    toast("Loaded!", { description: `"${save.name}" loaded`, duration: 2000 });
  }, []);

  const handleDeleteSave = useCallback((id: string) => {
    const updated = saves.filter((s) => s.id !== id);
    setSaves(updated);
    persistSaves(updated);
    toast("Deleted", { duration: 1500 });
  }, [saves]);

  const handleExportSave = useCallback((save: SavedTournament) => {
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${save.name.replace(/[^a-z0-9_\-\s]/gi, "").trim() || "tournament"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importFileRef = React.useRef<HTMLInputElement>(null);

  const handleImportSave = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string) as SavedTournament;
        if (!data.id || !data.name || !data.pods) throw new Error("Invalid file");
        const imported: SavedTournament = { ...data, id: Date.now().toString(), name: data.name + " (imported)" };
        const updated = [imported, ...saves].slice(0, 10);
        setSaves(updated);
        persistSaves(updated);
        toast.success(`Imported "${imported.name}"`);
      } catch {
        toast.error("Invalid tournament file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [saves]);

  // Publish
  const doPublish = useCallback(async (podsToPublish: Pod[], token: string) => {
    setPublishStatus("publishing");
    try {
      const payload = JSON.stringify({
        pods: podsToPublish,
        tournamentSize,
        tournamentMode,
        seeds,
        formatConfig,
        globalFormat,
        publishedAt: new Date().toISOString(),
      });
      const res = await fetch(`${WORKER_URL}/bracket`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": token },
        body: JSON.stringify({ state: payload }),
      });
      if (res.ok) {
        setIsLive(true);
        setPublishStatus("ok");
        setTimeout(() => setPublishStatus("idle"), 2000);
      } else {
        setAdminToken("");
        sessionStorage.removeItem("cb_admin_token");
        setPublishStatus("error");
        setTimeout(() => setPublishStatus("idle"), 2000);
      }
    } catch {
      setPublishStatus("error");
      setTimeout(() => setPublishStatus("idle"), 2000);
    }
  }, [tournamentSize, tournamentMode, seeds, formatConfig, globalFormat]);

  const publishBracket = useCallback((podsToPublish: Pod[]) => {
    if (!adminToken) {
      pendingAction.current = "publish";
      setTokenInput("");
      setTokenError("");
      setShowTokenDialog(true);
      return;
    }
    doPublish(podsToPublish, adminToken);
  }, [adminToken, doPublish]);

  const unpublishBracket = useCallback(async () => {
    const token = adminToken;
    if (!token) {
      pendingAction.current = "unpublish";
      setTokenInput("");
      setTokenError("");
      setShowTokenDialog(true);
      return;
    }
    try {
      await fetch(`${WORKER_URL}/bracket`, { method: "DELETE", headers: { "X-Admin-Token": token } });
      setIsLive(false);
    } catch { /* ignore */ }
  }, [adminToken]);

  const handleTokenSubmit = () => {
    if (!tokenInput.trim()) { setTokenError("Enter admin password"); return; }
    const token = tokenInput.trim();
    setAdminToken(token);
    sessionStorage.setItem("cb_admin_token", token);
    setShowTokenDialog(false);
    setTokenError("");
    if (pendingAction.current === "publish") doPublish(pods, token);
    else if (pendingAction.current === "unpublish") {
      fetch(`${WORKER_URL}/bracket`, { method: "DELETE", headers: { "X-Admin-Token": token } })
        .then(() => setIsLive(false)).catch(() => {});
    }
    else if (pendingAction.current === "generate-session") {
      if (pendingGenState.current) createSessionForState(pendingGenState.current, token);
      pendingGenState.current = null;
    }
    else if (pendingAction.current === "delete-session") {
      if (pendingDeleteCode.current) doDeleteSession(pendingDeleteCode.current, token);
      pendingDeleteCode.current = null;
    }
    pendingAction.current = null;
  };

  // ─── Session helpers ──────────────────────────────────────────────────────────

  const buildSessionState = useCallback(() => JSON.stringify({ pods, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, screen }), [pods, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, screen]);
  // Always-fresh accessor so effects can serialize current state without listing
  // pods in their deps (which would fire on every result click).
  const buildSessionStateRef = useRef(buildSessionState);
  buildSessionStateRef.current = buildSessionState;

  const adoptServerState = useCallback((stateStr: string, version: number, editor: string | null) => {
    try {
      const s = JSON.parse(stateStr);
      adoptingRef.current = true;
      if (s.pods) setPods(s.pods);
      if (s.tournamentSize) setTournamentSize(s.tournamentSize);
      if (s.tournamentMode) setTournamentMode(s.tournamentMode);
      if (s.seeds) setSeeds(s.seeds);
      if (s.formatConfig !== undefined) setFormatConfig(s.formatConfig);
      if (s.globalFormat) setGlobalFormat(s.globalFormat);
      if (s.finalsBracket !== undefined) setFinalsBracket(s.finalsBracket);
      if (s.screen) setScreen(s.screen);
      sessionVersionRef.current = version;
      setSessionVersion(version);
      if (editor) setLastEditor(editor);
      // Release the adoption guard after this render cycle's state-change effects settle.
      setTimeout(() => { adoptingRef.current = false; }, 50);
    } catch { /* ignore malformed */ }
  }, []);

  const doPutSession = useCallback(async (code: string, stateStr: string, token: string) => {
    sessionPutInFlight.current = true;
    setSyncStatus("syncing");
    try {
      const res = await fetch(`${WORKER_URL}/session/${code}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Admin-Token": token },
        body: JSON.stringify({
          state: stateStr,
          editor: editorNameRef.current || "Operator",
          name: tournamentNameRef.current || `${editorNameRef.current || "Operator"}'s Tournament`,
          size: tournamentSize,
          mode: tournamentMode,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { ok: boolean; version: number; lastEditor: string };
        sessionVersionRef.current = data.version;
        myVersionRef.current = data.version;
        setSessionVersion(data.version);
        setSyncStatus("synced");
        setTimeout(() => setSyncStatus("idle"), 2000);
      } else {
        setSyncStatus("idle");
      }
    } catch {
      setSyncStatus("idle");
    } finally {
      sessionPutInFlight.current = false;
    }
  }, []);

  // Sync STRUCTURAL changes (size / mode / seeds / format) as a full snapshot.
  // Live result/map/stream edits are sent as per-match mutations over WebSocket
  // (sendMutation), so `pods` is intentionally NOT in these deps.
  useEffect(() => {
    if (!sessionCode || !adminToken) return;
    if (adoptingRef.current) return; // change came from adopting server state
    if (sessionDebounceTimer.current) clearTimeout(sessionDebounceTimer.current);
    sessionDebounceTimer.current = setTimeout(() => {
      const code = sessionCodeRef.current;
      if (!code || adoptingRef.current) return;
      doPutSession(code, buildSessionStateRef.current(), adminToken);
    }, 600);
  }, [tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, sessionCode, adminToken, doPutSession]);

  // Live sync over WebSocket: receive authoritative state pushes (replaces polling).
  useEffect(() => {
    sessionCodeRef.current = sessionCode;
    const closeWs = () => {
      if (wsReconnectTimer.current) { clearTimeout(wsReconnectTimer.current); wsReconnectTimer.current = null; }
      if (wsRef.current) { try { wsRef.current.onclose = null; wsRef.current.close(); } catch { /* ignore */ } wsRef.current = null; }
    };
    if (!sessionCode) { closeWs(); return; }

    let cancelled = false;
    const scheduleReconnect = () => {
      if (cancelled) return;
      if (wsReconnectTimer.current) clearTimeout(wsReconnectTimer.current);
      wsReconnectTimer.current = setTimeout(connect, 1500);
    };
    function connect() {
      if (cancelled) return;
      const code = sessionCodeRef.current;
      if (!code) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${WS_URL}/session/${code}/ws?token=${encodeURIComponent(adminToken || "")}&editor=${encodeURIComponent(editorNameRef.current || "Operator")}`);
      } catch { scheduleReconnect(); return; }
      wsRef.current = ws;
      ws.onopen = () => {
        const out = wsOutbox.current; wsOutbox.current = [];
        for (const msg of out) { try { ws.send(msg); } catch { /* ignore */ } }
        setSyncStatus("synced");
        setTimeout(() => setSyncStatus("idle"), 1500);
      };
      ws.onmessage = (ev) => {
        let data: { t?: string; state?: string; version?: number; lastEditor?: string };
        try { data = JSON.parse(ev.data as string); } catch { return; }
        if (data.t === "state" && typeof data.state === "string" && typeof data.version === "number") {
          if (data.version > myVersionRef.current) {
            myVersionRef.current = data.version;
            adoptServerState(data.state, data.version, data.lastEditor ?? null);
            if (data.lastEditor && data.lastEditor !== editorNameRef.current) {
              toast(`Synced changes from ${data.lastEditor}`, { duration: 2500 });
            }
            setSyncStatus("synced");
            setTimeout(() => setSyncStatus("idle"), 1500);
          }
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
      ws.onclose = () => { if (!cancelled) scheduleReconnect(); };
    }
    connect();
    return () => { cancelled = true; closeWs(); };
  }, [sessionCode, adminToken, adoptServerState]);

  const generateSessionCode = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return "CB-" + Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  };

  const handleCreateSession = useCallback(() => {
    if (!adminToken) {
      pendingAction.current = null;
      setTokenInput("");
      setTokenError("");
      setShowTokenDialog(true);
      return;
    }
    const code = generateSessionCode();
    setSessionCode(code);
    sessionCodeRef.current = code;
    sessionVersionRef.current = 0;
    myVersionRef.current = 0;
    setSessionVersion(0);
    sessionStorage.setItem("cb_session_code", code);
    sessionStorage.setItem("cb_session_editor", editorNameRef.current || "Operator");
    doPutSession(code, buildSessionState(), adminToken);
    toast.success(`Session ${code} created!`, { duration: 3000 });
  }, [adminToken, buildSessionState, doPutSession]);

  const joinByCode = useCallback(async (codeRaw: string) => {
    const code = codeRaw.trim().toUpperCase();
    if (!code) { toast.error("Enter a session code"); return; }
    try {
      const res = await fetch(`${WORKER_URL}/session/${code}`);
      const data = await res.json() as { ok: boolean; state: string; version: number; lastEditor: string };
      if (!data.ok) { toast.error("Session not found"); return; }
      adoptServerState(data.state, data.version, data.lastEditor);
      myVersionRef.current = data.version;
      setSessionCode(code);
      sessionCodeRef.current = code;
      // Go straight into the bracket if the session already has one generated.
      // No need to press Generate Bracket (which would build a different random bracket).
      try {
        const s = JSON.parse(data.state);
        if (s.pods && s.pods.length > 0) setScreen("bracket");
      } catch { /* keep current screen */ }
      sessionStorage.setItem("cb_session_code", code);
      sessionStorage.setItem("cb_session_editor", editorNameRef.current || "Operator");
      setShowOngoing(false);
      toast.success(`Joined session ${code}`);
      setJoinCodeInput("");
    } catch { toast.error("Failed to join session"); }
  }, [adoptServerState]);

  const handleJoinSession = useCallback(() => joinByCode(joinCodeInput), [joinByCode, joinCodeInput]);

  // Create a session from an explicit serialized state (used by auto-session on Generate).
  const createSessionForState = useCallback((stateStr: string, token: string) => {
    const code = generateSessionCode();
    setSessionCode(code);
    sessionCodeRef.current = code;
    sessionVersionRef.current = 0;
    myVersionRef.current = 0;
    setSessionVersion(0);
    sessionStorage.setItem("cb_session_code", code);
    sessionStorage.setItem("cb_session_editor", editorNameRef.current || "Operator");
    doPutSession(code, stateStr, token);
    toast.success(`Session ${code} created`, { duration: 2500 });
  }, [doPutSession]);

  // Fetch the list of active tournaments (server-backed, 24h window).
  const fetchOngoing = useCallback(async () => {
    setOngoingLoading(true);
    try {
      const res = await fetch(`${WORKER_URL}/sessions/active`);
      const data = await res.json() as { ok: boolean; sessions: OngoingSession[] };
      if (data.ok) setOngoingSessions(data.sessions || []);
    } catch { /* ignore */ } finally { setOngoingLoading(false); }
  }, []);

  const doDeleteSession = useCallback(async (code: string, token: string) => {
    try {
      await fetch(`${WORKER_URL}/session/${code}`, { method: "DELETE", headers: { "X-Admin-Token": token } });
      setOngoingSessions((prev) => prev.filter((s) => s.code !== code));
      if (sessionCodeRef.current === code) {
        setSessionCode(null);
        sessionCodeRef.current = null;
        sessionStorage.removeItem("cb_session_code");
        sessionStorage.removeItem("cb_session_editor");
      }
      toast.success(`Deleted ${code}`);
    } catch { toast.error("Failed to delete session"); }
  }, []);

  const requestDeleteSession = useCallback((code: string) => {
    if (!adminToken) {
      pendingDeleteCode.current = code;
      pendingAction.current = "delete-session";
      setTokenInput("");
      setTokenError("");
      setShowTokenDialog(true);
      return;
    }
    doDeleteSession(code, adminToken);
  }, [adminToken, doDeleteSession]);

  const handleLeaveSession = useCallback(() => {
    setSessionCode(null);
    sessionCodeRef.current = null;
    setSyncStatus("idle");
    setLastEditor(null);
    sessionStorage.removeItem("cb_session_code");
    sessionStorage.removeItem("cb_session_editor");
    toast("Left session", { duration: 1500 });
  }, []);
  // Auto-rejoin session on mount if sessionStorage has a code
  useEffect(() => {
    const savedCode = sessionStorage.getItem("cb_session_code");
    if (!savedCode) return;
    const savedEditor = sessionStorage.getItem("cb_session_editor");
    if (savedEditor) setEditorName(savedEditor);
    fetch(`${WORKER_URL}/session/${savedCode}`)
      .then((r) => r.json())
      .then((data: { ok: boolean; state: string; version: number; lastEditor: string }) => {
        if (!data.ok) { sessionStorage.removeItem("cb_session_code"); return; }
        adoptServerState(data.state, data.version, data.lastEditor);
        myVersionRef.current = data.version;
        setSessionCode(savedCode);
        sessionCodeRef.current = savedCode;
        try { const s = JSON.parse(data.state); if (s.pods && s.pods.length > 0) setScreen("bracket"); } catch { /* keep */ }
        toast.success(`Rejoined session ${savedCode}`, { duration: 2000 });
      })
      .catch(() => sessionStorage.removeItem("cb_session_code"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Setup helpers
  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  const handleSizeChange = (s: Size) => {
    setTournamentSize(s);
    setSeeds(defaultSeeds(s));
    setFormatConfig({});
  };

  const handleNameChange = (idx: number, val: string) => {
    setSeeds((prev) => prev.map((s, i) => (i === idx ? { ...s, name: val } : s)));
  };

  const handleRandomize = () => {
    setSeeds((prev) => {
      const shuffled = shuffleArray(prev.map((_, i) => i));
      return shuffled.map((origIdx, i) => ({ ...prev[origIdx], seed: i + 1 }));
    });
  };

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };
  const handleDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); dragOverIdx.current = idx; };
  const handleDrop = () => {
    const from = dragIdx.current;
    const to = dragOverIdx.current;
    if (from === null || to === null || from === to) return;
    setSeeds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next.map((s, i) => ({ ...s, seed: i + 1 }));
    });
    dragIdx.current = null;
    dragOverIdx.current = null;
  };

  const handleGenerate = () => {
    const normalised = [...seeds].sort((a, b) => a.seed - b.seed).map((s, i) => ({ ...s, seed: i + 1 }));
    const cfg = resolveConfig(tournamentSize, tournamentMode, globalFormat, formatConfig, engineOpts);
    const initial = buildInitialPods(tournamentSize, normalised, tournamentMode, cfg, MAP_NAMES, undefined, engineOpts);
    setPods(initial);
    undoStack.current = [];
    redoStack.current = [];
    setScreen("bracket");
    // Auto-create a live session so the tournament appears in Ongoing and stays
    // persisted until deleted. Ask for the admin password once, then silent.
    if (!sessionCode) {
      const stateStr = JSON.stringify({ pods: initial, tournamentSize, tournamentMode, seeds: normalised, formatConfig, globalFormat, finalsBracket, screen: "bracket" });
      if (adminToken) {
        createSessionForState(stateStr, adminToken);
      } else {
        pendingGenState.current = stateStr;
        pendingAction.current = "generate-session";
        setTokenInput("");
        setTokenError("");
        setShowTokenDialog(true);
      }
    }
  };

  const handleTeamClick = useCallback(
    (podId: string, teamIdx: number) => {
      setPodsWithHistory((prev) => {
        const podIndex = prev.findIndex((p) => p.id === podId);
        if (podIndex === -1) return prev;
        const pod = prev[podIndex];
        const team = pod.teams[teamIdx];
        if (!team.name) return prev;

        let newPlacement: Placement;
        const maxPlace: Placement = pod.teams.length === 2 ? 2 : 4;

        if (team.placement !== 0) {
          newPlacement = 0;
        } else {
          const availablePlacements: Placement[] = [1, 2, 3, 4].slice(0, maxPlace) as Placement[];
          const taken = new Set(pod.teams.filter((_, i) => i !== teamIdx).map((t) => t.placement));
          const free = availablePlacements.find((p) => !taken.has(p));
          newPlacement = free ?? 0;
        }

        const newPods = prev.map((p, pi) => {
          if (pi !== podIndex) return p;
          return { ...p, teams: p.teams.map((t, ti) => ti === teamIdx ? { ...t, placement: newPlacement as TeamSlot["placement"] } : t) };
        });

        const cfg = resolveConfig(tournamentSize, tournamentMode, globalFormat, formatConfig, engineOpts);
        const result = propagate(newPods, tournamentSize, tournamentMode, cfg, engineOpts);

        // Send the single result as a mutation; the DO re-propagates authoritatively
        // so two operators editing different matches never overwrite each other.
        sendMutation({ t: "set-placement", podId, teamIdx, placement: newPlacement });

        if (autoPublish) {
          if (autoPublishTimer.current) clearTimeout(autoPublishTimer.current);
          autoPublishTimer.current = setTimeout(() => publishBracket(result), 1000);
        }

        return result;
      });
    },
    [tournamentSize, tournamentMode, globalFormat, formatConfig, engineOpts, autoPublish, publishBracket, setPodsWithHistory, sendMutation]
  );

  const handleReset = () => {
    const normalised = [...seeds].sort((a, b) => a.seed - b.seed).map((s, i) => ({ ...s, seed: i + 1 }));
    const cfg = resolveConfig(tournamentSize, tournamentMode, globalFormat, formatConfig, engineOpts);
    const fresh = buildInitialPods(tournamentSize, normalised, tournamentMode, cfg, MAP_NAMES, undefined, engineOpts);
    // Preserve the maps that are currently assigned - reset clears progress, not maps.
    const currentMaps = new Map(pods.map((p) => [p.id, p.map]));
    const withMaps = fresh.map((p) => ({ ...p, map: currentMaps.get(p.id) ?? p.map }));
    setPodsWithHistory(withMaps);
    // Reset is a full replacement -> push the whole snapshot.
    if (sessionCodeRef.current && adminToken) {
      doPutSession(sessionCodeRef.current, JSON.stringify({ pods: withMaps, tournamentSize, tournamentMode, seeds: normalised, formatConfig, globalFormat, finalsBracket, screen: "bracket" }), adminToken);
    }
  };

  const handleNewTournament = () => {
    setScreen("setup");
    setScreenshotMode(false);
    document.body.classList.remove("screenshot-mode");
  };

  const handleScreenshot = () => {
    const next = !screenshotMode;
    setScreenshotMode(next);
    document.body.classList.toggle("screenshot-mode", next);
  };
  const handleCompact = () => {
    const next = !compactMode;
    setCompactMode(next);
    document.body.classList.toggle("compact-mode", next);
  };
  const bracketRef = useRef<HTMLDivElement>(null);

  const handleExportPng = async () => {
    const el = bracketRef.current;
    if (!el) { toast.error("Bracket not found"); return; }
    toast("Generating PNG...");
    try {
      const canvas = await html2canvas(el, { backgroundColor: "#0a0a0a", scale: 2, useCORS: true, logging: false });
      const link = document.createElement("a");
      link.download = "codebreakers-bracket.png";
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast.success("PNG saved!");
    } catch (err) {
      console.error(err);
      toast.error("Failed to export PNG");
    }
  };

  // Map picker
  const setPodMap = useCallback((podId: string, mapName: string) => {
    setPodsWithHistory(prev => prev.map(p => p.id === podId ? { ...p, map: mapName } : p));
    setMapPickerPod(null);
    sendMutation({ t: "set-map", podId, map: mapName });
  }, [setPodsWithHistory, sendMutation]);

  // Toggle which match is being streamed (only one at a time)
  // Cycle a pod's stream state: off -> onStream -> liveNow -> off.
  // Multiple pods can be onStream; only one can be liveNow at a time.
  const togglePodStreaming = useCallback((podId: string) => {
    setPodsWithHistory(prev => {
      const target = prev.find(p => p.id === podId);
      if (!target) return prev;
      let next: "off" | "onStream" | "liveNow";
      if (!target.onStream && !target.liveNow) next = "onStream";
      else if (target.onStream && !target.liveNow) next = "liveNow";
      else next = "off";
      sendMutation({ t: "set-stream", podId, onStream: next !== "off", liveNow: next === "liveNow" });
      return prev.map(p => {
        if (p.id === podId) {
          if (next === "off") return { ...p, onStream: false, liveNow: false };
          if (next === "onStream") return { ...p, onStream: true, liveNow: false };
          return { ...p, onStream: true, liveNow: true }; // liveNow
        }
        // clear liveNow on all others when one goes live; leave their onStream intact
        return next === "liveNow" ? { ...p, liveNow: false } : p;
      });
    });
  }, [setPodsWithHistory, sendMutation]);

  // CSV import
  const handleCsvFetch = async () => {
    if (!csvUrl.trim()) { toast.error("Enter a CSV URL"); return; }
    setCsvLoading(true);
    try {
      const res = await fetch(csvUrl.trim());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error("No data rows found");
      setCsvRows(rows);
      // Auto-guess columns from headers
      const headers = rows[0].map(h => h.toLowerCase());
      const nameIdx = headers.findIndex(h => h.includes("team name") || h.includes("team"));
      const strengthIdx = headers.findIndex(h => h.includes("strength"));
      const playerIdxs = headers.map((h, i) => h.includes("embark") || h.includes("player") ? i : -1).filter(i => i >= 0);
      if (nameIdx >= 0) setCsvNameCol(nameIdx);
      if (strengthIdx >= 0) setCsvStrengthCol(strengthIdx);
      if (playerIdxs.length > 0) setCsvPlayerCols(playerIdxs);
      toast.success(`Loaded ${rows.length - 1} rows`);
    } catch (e: unknown) {
      toast.error(`Failed to fetch CSV: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCsvLoading(false);
    }
  };

  const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const rows = parseCsv(ev.target?.result as string);
        if (rows.length < 2) throw new Error("No data rows");
        setCsvRows(rows);
        const headers = rows[0].map(h => h.toLowerCase());
        const nameIdx = headers.findIndex(h => h.includes("team name") || h.includes("team"));
        const strengthIdx = headers.findIndex(h => h.includes("strength"));
        const playerIdxs = headers.map((h, i) => h.includes("embark") || h.includes("player") ? i : -1).filter(i => i >= 0);
        if (nameIdx >= 0) setCsvNameCol(nameIdx);
        if (strengthIdx >= 0) setCsvStrengthCol(strengthIdx);
        if (playerIdxs.length > 0) setCsvPlayerCols(playerIdxs);
        toast.success(`Loaded ${rows.length - 1} rows`);
      } catch { toast.error("Invalid CSV file"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleCsvApply = () => {
    if (!csvRows) return;
    const newSeeds = seedsFromImport(csvRows, csvNameCol, csvStrengthCol, csvPlayerCols, tournamentSize);
    setSeeds(newSeeds);
    setShowCsvPanel(false);
    toast.success(`Imported ${newSeeds.filter(s => !s.name.startsWith("TBD")).length} teams`);
  };

  // Connectors - derived from propagate dest-pod matching (phase-based, not hardcoded)
  const [connectors, setConnectors] = useState<Connector[]>([]);

  useEffect(() => {
    if (screen !== "bracket" || !bracketRef.current) return;
    const measure = () => {
      const container = bracketRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const lines: Connector[] = [];
      const graph = getPhaseGraph(tournamentSize, tournamentMode, engineOpts);
      const phaseById = new Map(graph.map(p => [p.id, p]));

      for (const pod of pods) {
        const phase = phaseById.get(pod.phase);
        if (!phase) continue;
        const srcEl = container.querySelector(`[data-pod-id="${pod.id}"]`);
        if (!srcEl) continue;
        const srcRows = srcEl.querySelectorAll(".team-row");
        const podSize = pod.teams.length;
        const advanceCount = podSize / 2;

        // Advance connectors
        if (phase.advanceTo) {
          const advancingTeams = pod.teams
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => t.placement >= 1 && t.placement <= advanceCount && t.name)
            .sort((a, b) => a.t.placement - b.t.placement);

          // Find dest pods that contain each advancing team (after propagate)
          for (const { t, i: srcRowIdx } of advancingTeams) {
            const destPod = pods.find(p => p.phase === phase.advanceTo && p.teams.some(dt => dt.seed === t.seed && dt.name));
            if (!destPod) continue;
            const dstEl = container.querySelector(`[data-pod-id="${destPod.id}"]`);
            if (!dstEl) continue;
            const dstRows = dstEl.querySelectorAll(".team-row");
            const dstRowIdx = destPod.teams.findIndex(dt => dt.seed === t.seed && dt.name);
            const srcRow = srcRows[srcRowIdx];
            const dstRow = dstRows[dstRowIdx];
            if (!srcRow || !dstRow) continue;
            const s = srcRow.getBoundingClientRect();
            const d = dstRow.getBoundingClientRect();
            lines.push({
              x1: s.right - containerRect.left, y1: s.top + s.height / 2 - containerRect.top,
              x2: d.left - containerRect.left, x2R: d.right - containerRect.left, y2: d.top + d.height / 2 - containerRect.top,
              key: `${pod.id}-adv-${t.name}`, active: true, channelX: 0,
            });
          }
          // Ghost lines for empty advance slots
          if (advancingTeams.length === 0) {
            const destPhasePods = pods.filter(p => p.phase === phase.advanceTo);
            for (let i = 0; i < Math.min(advanceCount, 2); i++) {
              const destPod = destPhasePods[Math.floor(i / 2)] || destPhasePods[0];
              if (!destPod) continue;
              const dstEl = container.querySelector(`[data-pod-id="${destPod.id}"]`);
              if (!dstEl) continue;
              const srcRow = srcRows[i];
              const dstRows = dstEl.querySelectorAll(".team-row");
              const dstRow = dstRows[i % destPod.teams.length];
              if (!srcRow || !dstRow) continue;
              const s = srcRow.getBoundingClientRect();
              const d = dstRow.getBoundingClientRect();
              lines.push({
                x1: s.right - containerRect.left, y1: s.top + s.height / 2 - containerRect.top,
                x2: d.left - containerRect.left, x2R: d.right - containerRect.left, y2: d.top + d.height / 2 - containerRect.top,
                key: `${pod.id}-ghost-${i}`, active: false, channelX: 0,
              });
            }
          }
        }

        // Drop connectors (DE WB only)
        if (phase.dropTo && tournamentMode === "double" && !phase.hasNoLBDrop) {
          const dropCount = podSize / 2;
          const droppingTeams = pod.teams
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => t.placement > advanceCount && t.placement <= podSize && t.name)
            .sort((a, b) => a.t.placement - b.t.placement);

          for (const { t, i: srcRowIdx } of droppingTeams) {
            const destPod = pods.find(p => p.phase === phase.dropTo && p.teams.some(dt => dt.seed === t.seed && dt.name));
            if (!destPod) continue;
            const dstEl = container.querySelector(`[data-pod-id="${destPod.id}"]`);
            if (!dstEl) continue;
            const dstRows = dstEl.querySelectorAll(".team-row");
            const dstRowIdx = destPod.teams.findIndex(dt => dt.seed === t.seed && dt.name);
            const srcRow = srcRows[srcRowIdx];
            const dstRow = dstRows[dstRowIdx];
            if (!srcRow || !dstRow) continue;
            const s = srcRow.getBoundingClientRect();
            const d = dstRow.getBoundingClientRect();
            lines.push({
              x1: s.right - containerRect.left, y1: s.top + s.height / 2 - containerRect.top,
              x2: d.left - containerRect.left, x2R: d.right - containerRect.left, y2: d.top + d.height / 2 - containerRect.top,
              key: `${pod.id}-drop-${t.name}`, active: true, isDrop: true, channelX: 0,
            });
          }
          // Ghost drop lines
          if (droppingTeams.length === 0) {
            const destPhasePods = pods.filter(p => p.phase === phase.dropTo);
            for (let i = 0; i < Math.min(dropCount, 2); i++) {
              const destPod = destPhasePods[Math.floor(i / 2)] || destPhasePods[0];
              if (!destPod) continue;
              const dstEl = container.querySelector(`[data-pod-id="${destPod.id}"]`);
              if (!dstEl) continue;
              const srcRow = srcRows[advanceCount + i];
              const dstRows = dstEl.querySelectorAll(".team-row");
              const dstRow = dstRows[i % destPod.teams.length];
              if (!srcRow || !dstRow) continue;
              const s = srcRow.getBoundingClientRect();
              const d = dstRow.getBoundingClientRect();
              lines.push({
                x1: s.right - containerRect.left, y1: s.top + s.height / 2 - containerRect.top,
                x2: d.left - containerRect.left, x2R: d.right - containerRect.left, y2: d.top + d.height / 2 - containerRect.top,
                key: `${pod.id}-ghostdrop-${i}`, active: false, isDrop: true, channelX: 0,
              });
            }
          }
        }
      }
      // Assign each line a vertical corridor (channelX) so orthogonal routes
      // don't overlap. Lines leaving the same source share a corridor placed
      // just right of the source; we nudge by index to fan them out cleanly.
      // Special case: when the destination is NOT clearly to the right of the
      // source (e.g. the finals are stacked vertically in the same column),
      // route the corridor to the RIGHT of both pods so the line doesn't cut
      // back horizontally through the destination pod (the "strikethrough" bug).
      const bySource = new Map<string, Connector[]>();
      for (const ln of lines) {
        const srcKey = ln.key.split("-")[0] + "-" + (ln.key.split("-")[1] ?? "");
        if (!bySource.has(srcKey)) bySource.set(srcKey, []);
        bySource.get(srcKey)!.push(ln);
      }
      for (const group of Array.from(bySource.values())) {
        group.forEach((ln: Connector, gi: number) => {
          const gap = ln.x2 - ln.x1;
          if (gap < 12) {
            // Same-column / stacked (finals, WB->LB drops): the corridor sits to
            // the RIGHT of both pods and the line ENTERS THE DEST FROM ITS RIGHT
            // EDGE. Entering at the left edge here would drag the horizontal
            // segment across the whole pod (the "strikethrough" bug).
            ln.x2 = ln.x2R;
            ln.channelX = Math.max(ln.x1, ln.x2R) + 12 + gi * 5;
          } else {
            // Normal left-to-right: corridor must stay INSIDE the gutter between
            // the columns, never past the destination's left edge.
            const base = ln.x1 + Math.max(8, Math.min(gap * 0.4, gap - 8));
            ln.channelX = Math.min(base + gi * 5, ln.x2 - 6);
          }
        });
      }
      setConnectors(lines);
    };
    const raf = requestAnimationFrame(measure);
    // also re-measure on the next frame after a layout-affecting toggle settles
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(measure));
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); window.removeEventListener("resize", measure); };
  }, [pods, screen, tournamentSize, tournamentMode, compactMode, finalsBracket]);

  const phases = screen === "bracket" ? groupPodsByPhase(pods, tournamentMode, tournamentSize, engineOpts) : [];
  const isDE = tournamentMode === "double";
  const wbPhases = phases.filter((ph) => ph.bracket === "wb");
  const lbPhases = phases.filter((ph) => ph.bracket === "lb");
  const gfPhases = phases.filter((ph) => ph.bracket === "gf");

  // Format toggle helpers
  const graph = getPhaseGraph(tournamentSize, tournamentMode, engineOpts);
  const wbGraphPhases = graph.filter(p => p.bracket === "wb" && p.id !== "gf");
  const lbGraphPhases = graph.filter(p => p.bracket === "lb");
  const gfGraphPhases = graph.filter(p => p.bracket === "gf" && p.id !== "gf");

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div className="cb-header">
        <img src={LOGO_URL} alt="Codebreakers" className="cb-logo" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        <div className="cb-title">CODEBREAKERS</div>
        <div className="cb-subtitle">TOURNAMENT BRACKET</div>
      </div>

      {/* Setup Screen */}
      {screen === "setup" && (
        <div className="setup-screen">
          {/* Mode selector */}
          <div className="setup-title">Tournament Mode</div>
          <div className="mode-selector">
            <button className={`mode-btn${tournamentMode === "single" ? " active" : ""}`} onClick={() => setTournamentMode("single")}>
              <span className="mode-btn-title">SINGLE ELIMINATION</span>
              <span className="mode-btn-desc">3rd/4th = eliminated immediately</span>
            </button>
            <button className={`mode-btn${tournamentMode === "double" ? " active de" : ""}`} onClick={() => setTournamentMode("double")}>
              <span className="mode-btn-title">DOUBLE ELIMINATION</span>
              <span className="mode-btn-desc">3rd/4th drop to Losers Bracket · 2 chances</span>
            </button>
          </div>

          {/* Size selector */}
          <div className="setup-title" style={{ marginTop: "28px" }}>Tournament Size</div>
          <div className="size-selector">
            {([8, 16, 32] as const).map((s) => (
              <button key={s} className={`size-btn${tournamentSize === s ? " active" : ""}`} onClick={() => handleSizeChange(s)}>{s}</button>
            ))}
          </div>

          {/* Match Format panel */}
          <div className="setup-title" style={{ marginTop: "28px" }}>Match Format</div>
          <div className="format-panel">
            <div className="format-global-row">
              <span className="format-label">GLOBAL DEFAULT</span>
              <div className="format-toggle-group">
                <button
                  className={`format-toggle-btn${globalFormat === 4 ? " active" : ""}`}
                  onClick={() => setGlobalFormat(4)}
                >4-TEAM CASH-OUT</button>
                <button
                  className={`format-toggle-btn${globalFormat === 2 ? " active" : ""}`}
                  onClick={() => setGlobalFormat(2)}
                >2-TEAM FINAL ROUND</button>
              </div>
            </div>

            {/* Per-phase overrides - grouped for DE */}
            {isDE ? (
              <>
                {wbGraphPhases.length > 0 && (
                  <div className="format-section">
                    <div className="format-section-label">WINNERS BRACKET</div>
                    {wbGraphPhases.map(ph => (
                      <FormatPhaseRow key={ph.id} phase={ph} formatConfig={formatConfig} globalFormat={globalFormat} setFormatConfig={setFormatConfig} />
                    ))}
                  </div>
                )}
                {lbGraphPhases.length > 0 && (
                  <div className="format-section">
                    <div className="format-section-label">LOSERS BRACKET</div>
                    {lbGraphPhases.map(ph => (
                      <FormatPhaseRow key={ph.id} phase={ph} formatConfig={formatConfig} globalFormat={globalFormat} setFormatConfig={setFormatConfig} />
                    ))}
                  </div>
                )}
                {gfGraphPhases.length > 0 && (
                  <div className="format-section">
                    <div className="format-section-label">FINALS</div>
                    {gfGraphPhases.map(ph => (
                      <FormatPhaseRow key={ph.id} phase={ph} formatConfig={formatConfig} globalFormat={globalFormat} setFormatConfig={setFormatConfig} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="format-section">
                {graph.filter(p => p.id !== "gf").map(ph => (
                  <FormatPhaseRow key={ph.id} phase={ph} formatConfig={formatConfig} globalFormat={globalFormat} setFormatConfig={setFormatConfig} />
                ))}
              </div>
            )}
            <div className="format-locked-row">
              <span className="format-label" style={{ color: "var(--cb-muted)" }}>GRAND FINAL</span>
              <span style={{ fontSize: 11, color: "var(--cb-muted)", letterSpacing: "0.05em" }}>2-TEAM (locked)</span>
            </div>
          </div>

          {/* Finals format */}
          <div className="setup-title" style={{ marginTop: "28px" }}>Finals Format</div>
          <div className="format-panel">
            <div className="format-global-row">
              <span className="format-label">FINALS STRUCTURE</span>
              <div className="format-toggle-group">
                <button
                  className={`format-toggle-btn${!finalsBracket ? " active" : ""}`}
                  onClick={() => setFinalsBracket(false)}
                >DIRECT TO GRAND FINAL</button>
                <button
                  className={`format-toggle-btn${finalsBracket ? " active" : ""}`}
                  onClick={() => setFinalsBracket(true)}
                >HEAD-TO-HEAD SEMIS</button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--cb-muted)", letterSpacing: "0.04em", padding: "8px 4px 2px", lineHeight: 1.5 }}>
              {finalsBracket
                ? "Cash-Out Final (4 teams) splits into two 1v1 games: 1st vs 4th and 2nd vs 3rd. Each winner advances to the Grand Final."
                : "Cash-Out Final (4 teams) sends its top 2 straight to the Grand Final."}
            </div>
          </div>

          {/* CSV Import panel */}
          <div className="setup-title" style={{ marginTop: "28px" }}>
            <span>Import Teams</span>
            <button className="cb-btn" style={{ marginLeft: 12, padding: "4px 12px", fontSize: 11 }} onClick={() => setShowCsvPanel(!showCsvPanel)}>
              {showCsvPanel ? "Hide" : "Show"}
            </button>
          </div>
          {showCsvPanel && (
            <div className="csv-panel">
              <div className="csv-row">
                <input
                  className="team-input"
                  type="text"
                  value={csvUrl}
                  onChange={(e) => setCsvUrl(e.target.value)}
                  placeholder="Published Google Sheet CSV URL..."
                  style={{ flex: 1 }}
                />
                <button className="cb-btn" style={{ borderColor: "#06b6d4", color: "#22d3ee" }} onClick={handleCsvFetch} disabled={csvLoading}>
                  {csvLoading ? "Loading..." : "Fetch"}
                </button>
              </div>
              <div className="csv-row" style={{ gap: 8 }}>
                <input ref={csvFileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleCsvFile} />
                <button className="cb-btn" style={{ fontSize: 11 }} onClick={() => csvFileRef.current?.click()}>
                  Upload .csv file
                </button>
              </div>

              {csvRows && (
                <div className="csv-mapping">
                  <div className="csv-mapping-title">Column Mapping ({csvRows.length - 1} rows)</div>
                  <div className="csv-mapping-row">
                    <span className="csv-mapping-label">Team Name</span>
                    <select className="csv-select" value={csvNameCol} onChange={e => setCsvNameCol(Number(e.target.value))}>
                      {csvRows[0].map((h, i) => <option key={i} value={i}>{h || `Col ${i}`}</option>)}
                    </select>
                  </div>
                  <div className="csv-mapping-row">
                    <span className="csv-mapping-label">Strength</span>
                    <select className="csv-select" value={csvStrengthCol} onChange={e => setCsvStrengthCol(Number(e.target.value))}>
                      {csvRows[0].map((h, i) => <option key={i} value={i}>{h || `Col ${i}`}</option>)}
                    </select>
                  </div>
                  <div className="csv-mapping-row" style={{ alignItems: "flex-start" }}>
                    <span className="csv-mapping-label" style={{ paddingTop: 4 }}>Player Embark IDs</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {csvRows[0].map((h, i) => (
                        <label key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--cb-muted)", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={csvPlayerCols.includes(i)}
                            onChange={e => {
                              setCsvPlayerCols(prev => e.target.checked ? [...prev, i] : prev.filter(x => x !== i));
                            }}
                            style={{ accentColor: "#7c3aed" }}
                          />
                          {h || `Col ${i}`}
                        </label>
                      ))}
                    </div>
                  </div>
                  <button className="cb-btn generate" style={{ marginTop: 8 }} onClick={handleCsvApply}>
                    Apply Import
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Seeding panel */}
          <div className="setup-section-header" style={{ marginTop: "28px" }}>
            <span className="setup-title" style={{ marginBottom: 0 }}>Seeds &amp; Team Names</span>
          </div>
          <div className="setup-hint">Drag rows to reorder · Seed 1 = strongest</div>

          <div className="seeds-list">
            {seeds.map((entry, i) => (
              <div key={i} className="seed-row" draggable onDragStart={() => handleDragStart(i)} onDragOver={(e) => handleDragOver(e, i)} onDrop={handleDrop}>
                <span className="seed-drag-handle">⠿</span>
                <span className="seed-number">#{entry.seed}</span>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                  <input className="team-input" type="text" value={entry.name} placeholder={`Team ${i + 1}`} onChange={(e) => handleNameChange(i, e.target.value)} maxLength={24} />
                  <input
                    className="team-input players-input"
                    type="text"
                    value={(entry.players ?? []).join(", ")}
                    placeholder="Players: Player1, Player2, Player3..."
                    onChange={(e) => {
                      const players = e.target.value.split(",").map((p) => p.trim()).filter(Boolean);
                      setSeeds((prev) => prev.map((s, si) => si === i ? { ...s, players } : s));
                    }}
                    style={{ fontSize: 11, opacity: 0.7 }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Session panel on setup screen */}
          <div className="setup-title" style={{ marginTop: "28px" }}>
            <span>Session</span>
            <button className="cb-btn" style={{ marginLeft: 12, padding: "4px 12px", fontSize: 11 }} onClick={() => setShowSessionPanel(!showSessionPanel)}>
              {showSessionPanel ? "Hide" : "Show"}
            </button>
          </div>
          {showSessionPanel && (
            <div style={{ background: "#111115", border: "1px solid var(--cb-border)", padding: "16px", marginBottom: 8, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 11, color: "var(--cb-muted)", letterSpacing: "0.05em" }}>Tournament name (shown in gallery)</div>
              <input
                className="team-input"
                type="text"
                value={tournamentName}
                onChange={(e) => { setTournamentName(e.target.value); sessionStorage.setItem("cb_session_name", e.target.value); }}
                placeholder="e.g. CODE Big League..."
                style={{ maxWidth: 320 }}
              />
              <div style={{ fontSize: 11, color: "var(--cb-muted)", letterSpacing: "0.05em", marginTop: 4 }}>Your name (shown to co-editor)</div>
              <input
                className="team-input"
                type="text"
                value={editorName}
                onChange={(e) => { setEditorName(e.target.value); localStorage.setItem("cb_editor", e.target.value); }}
                placeholder="Your name..."
                style={{ maxWidth: 260 }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button className="cb-btn" style={{ borderColor: "#7c3aed", color: "#a78bfa" }} onClick={handleCreateSession}>
                  Create Session
                </button>
                {sessionCode && (
                  <>
                    <span style={{ fontFamily: "'Saira Condensed', monospace", fontSize: 15, fontWeight: 800, color: "#c4b5fd", letterSpacing: "0.15em", background: "rgba(124,58,237,0.15)", padding: "4px 10px", border: "1px solid #7c3aed" }}>{sessionCode}</span>
                    <button className="cb-btn" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => { navigator.clipboard.writeText(sessionCode); toast("Code copied!"); }}>Copy Code</button>
                    <button className="cb-btn" style={{ fontSize: 11, padding: "4px 10px", borderColor: "#10b981", color: "#34d399" }} onClick={() => { navigator.clipboard.writeText(`https://rauder999.github.io/codebreakers-bracket/live.html?session=${sessionCode}`); toast.success("Live link copied!"); }}>Copy Live Link</button>
                    <button className="cb-btn" style={{ fontSize: 11, padding: "4px 10px", borderColor: "#ef4444", color: "#f87171" }} onClick={handleLeaveSession}>Leave</button>
                  </>
                )}
              </div>
              <div style={{ borderTop: "1px solid var(--cb-border)", paddingTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  className="team-input"
                  type="text"
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                  placeholder="CB-XXXX"
                  style={{ maxWidth: 120, letterSpacing: "0.1em" }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleJoinSession(); }}
                />
                <button className="cb-btn" style={{ borderColor: "#06b6d4", color: "#22d3ee" }} onClick={handleJoinSession}>
                  Join Session
                </button>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 0 }}>
            <button className="cb-btn generate" style={{ flex: 1 }} onClick={handleGenerate}>
              Generate Bracket
            </button>
            <button className="cb-btn" style={{ borderColor: "#06b6d4", color: "#22d3ee", padding: "12px 20px", fontSize: 14, fontWeight: 700 }} onClick={() => { setShowOngoing(true); fetchOngoing(); }}>
              Connect to Session
            </button>
            {saves.length > 0 && (
              <button className="cb-btn" style={{ borderColor: "#f59e0b", color: "#fbbf24", padding: "12px 20px", fontSize: 14, fontWeight: 700 }} onClick={() => setShowSavePanel(true)}>
                Load Saved ({saves.length})
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bracket View */}
      {screen === "bracket" && (
        <div ref={bracketRef} className={`bracket-container${isDE ? " de-layout" : ""}${compactMode ? " compact-mode" : ""}`} style={{ position: "relative", flex: 1 }}>
          {/* Connector SVG */}
          <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0, overflow: "visible" }}>
            {connectors.map((c) => {
              const color = c.isDrop ? (c.active ? "#f97316" : "#2a1808") : (c.active ? "#22c55e" : "#1e1e28");
              const strokeWidth = c.active ? 1.6 : 1;
              const dashArray = c.isDrop ? "4,5" : undefined;
              // Orthogonal route: out from source -> vertical in a dedicated channel -> into dest.
              // The corridor (cx) may sit to the right of BOTH endpoints (stacked finals),
              // so the approach into dest can come from the right. Allow cx beyond x2.
              const cx = Math.max(c.x1 + 8, c.channelX);
              const dirY = c.y2 >= c.y1 ? 1 : -1;       // vertical travel direction
              const dirIn = c.x2 >= cx ? 1 : -1;         // horizontal approach into dest (+1 from left, -1 from right)
              const r = Math.max(0, Math.min(8, Math.abs(c.y2 - c.y1) / 2, Math.abs(cx - c.x1), Math.abs(c.x2 - cx)));
              const d = r > 1
                ? `M ${c.x1} ${c.y1} `
                  + `L ${cx - r} ${c.y1} `
                  + `Q ${cx} ${c.y1} ${cx} ${c.y1 + dirY * r} `
                  + `L ${cx} ${c.y2 - dirY * r} `
                  + `Q ${cx} ${c.y2} ${cx + dirIn * r} ${c.y2} `
                  + `L ${c.x2} ${c.y2}`
                : `M ${c.x1} ${c.y1} L ${cx} ${c.y1} L ${cx} ${c.y2} L ${c.x2} ${c.y2}`;
              return (
                <path key={c.key} d={d}
                  stroke={color} strokeWidth={strokeWidth} strokeDasharray={dashArray}
                  fill="none" strokeLinejoin="round" strokeLinecap="round"
                  opacity={c.active ? 1 : 0.4} />
              );
            })}
          </svg>

          {/* Single Elimination */}
          {!isDE && phases.map((ph, phIdx) => (
            <React.Fragment key={ph.phase}>
              {phIdx > 0 && <div className="connector-spacer" />}
              <div className="bracket-phase" style={{ zIndex: 1 }}>
                <div className="phase-label">{ph.label}</div>
                <div className="pods-column">
                  {ph.pods.map((pod) => (
                    <MatchPod key={pod.id} pod={pod} isGF={pod.phase === "gf"} isDE={false}
                      onTeamClick={handleTeamClick} onMapClick={setMapPickerPod} onStreamToggle={togglePodStreaming} screenshotMode={screenshotMode} />
                  ))}
                </div>
              </div>
            </React.Fragment>
          ))}

          {/* Double Elimination */}
          {isDE && (
            <div className="de-bracket-wrapper">
              <div className="de-row wb-row">
                <div className="de-row-label wb-row-label">WINNERS BRACKET</div>
                <div className="de-row-phases">
                  {wbPhases.map((ph, phIdx) => (
                    <React.Fragment key={ph.phase}>
                      {phIdx > 0 && <div className="connector-spacer" />}
                      <div className="bracket-phase" style={{ zIndex: 1 }}>
                        <div className="phase-label">{ph.label}</div>
                        <div className="pods-column">
                          {ph.pods.map((pod) => (
                            <MatchPod key={pod.id} pod={pod} isGF={false} isDE={true}
                              onTeamClick={handleTeamClick} onMapClick={setMapPickerPod} onStreamToggle={togglePodStreaming} screenshotMode={screenshotMode} />
                          ))}
                        </div>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </div>

              <div className="de-zone-divider" />

              <div className="de-row lb-row">
                <div className="de-row-label lb-row-label">LOSERS BRACKET</div>
                <div className="de-row-phases">
                  {lbPhases.map((ph, phIdx) => (
                    <React.Fragment key={ph.phase}>
                      {phIdx > 0 && <div className="connector-spacer" />}
                      <div className="bracket-phase" style={{ zIndex: 1 }}>
                        <div className="phase-label lb-phase-label">{ph.label}</div>
                        <div className="pods-column">
                          {ph.pods.map((pod) => (
                            <MatchPod key={pod.id} pod={pod} isGF={false} isDE={true} isLB={true}
                              onTeamClick={handleTeamClick} onMapClick={setMapPickerPod} onStreamToggle={togglePodStreaming} screenshotMode={screenshotMode} />
                          ))}
                        </div>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              </div>

              {gfPhases.length > 0 && (
                <div className="de-gf-column">
                  {gfPhases.map((ph) => (
                    <React.Fragment key={ph.phase}>
                      <div className="phase-label gf-phase-label" style={{ paddingBottom: 12 }}>{ph.label}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
                        {ph.pods.map((pod) => (
                          <MatchPod key={pod.id} pod={pod} isGF={pod.phase === "gf"} isDE={true}
                            onTeamClick={handleTeamClick} onMapClick={setMapPickerPod} onStreamToggle={togglePodStreaming} screenshotMode={screenshotMode} />
                        ))}
                      </div>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Map Picker Slide-out */}
      {mapPickerPod && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 800 }}
          onClick={() => setMapPickerPod(null)}
        >
          <div
            style={{
              position: "absolute", top: 0, right: 0, bottom: 0, width: 320,
              background: "#0a0a0a", borderLeft: "1px solid var(--cb-border)",
              display: "flex", flexDirection: "column",
              fontFamily: "'Saira Condensed', sans-serif",
              boxShadow: "-4px 0 24px rgba(0,0,0,0.7)",
              transform: "translateX(0)",
              transition: "transform 0.2s cubic-bezier(0.23,1,0.32,1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--cb-border)" }}>
              <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: "0.2em", color: "#b8b8cc", textTransform: "uppercase" }}>Select Map</span>
              <button className="cb-btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setMapPickerPod(null)}>X</button>
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {MAP_NAMES.map((mapName) => {
                const currentPod = pods.find(p => p.id === mapPickerPod);
                const isSelected = currentPod?.map === mapName;
                return (
                  <div
                    key={mapName}
                    onClick={() => setPodMap(mapPickerPod, mapName)}
                    style={{
                      padding: "12px 20px",
                      borderBottom: "1px solid var(--cb-border)",
                      cursor: "pointer",
                      background: isSelected ? "rgba(155,109,255,0.12)" : "transparent",
                      borderLeft: isSelected ? "2px solid #9b6dff" : "2px solid transparent",
                      display: "flex", alignItems: "center", gap: 10,
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <span style={{ fontSize: 13, fontWeight: isSelected ? 700 : 500, color: isSelected ? "#c4b5fd" : "#b8b8cc", letterSpacing: "0.05em" }}>
                      {mapName}
                    </span>
                    {isSelected && <span style={{ fontSize: 10, color: "#9b6dff", marginLeft: "auto" }}>SELECTED</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Admin Token Dialog */}
      {showTokenDialog && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowTokenDialog(false); }}>
          <div style={{ background: "#111115", border: "1px solid #333340", padding: "28px 32px", minWidth: 320, maxWidth: 400, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: "0.2em", color: "#e8e8f0" }}>ADMIN PASSWORD</div>
            <div style={{ fontSize: 12, color: "#888899", lineHeight: 1.5 }}>Enter the admin password to publish the bracket.</div>
            <input type="password" autoFocus value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleTokenSubmit(); if (e.key === "Escape") setShowTokenDialog(false); }}
              placeholder="Password"
              style={{ background: "#0a0a0a", border: "1px solid #333340", color: "#e8e8f0", padding: "8px 12px", fontSize: 13, fontFamily: "'Saira Condensed', sans-serif", outline: "none", letterSpacing: "0.1em" }}
            />
            {tokenError && <div style={{ fontSize: 11, color: "#ef4444" }}>{tokenError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="cb-btn" onClick={() => setShowTokenDialog(false)}>Cancel</button>
              <button className="cb-btn" style={{ borderColor: "#7c3aed", color: "#a78bfa" }} onClick={handleTokenSubmit}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* Ongoing Tournaments modal */}
      {showOngoing && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setShowOngoing(false); }}
          style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Saira Condensed', sans-serif" }}>
          <div style={{ width: 540, maxWidth: "92vw", maxHeight: "72vh", background: "#0d0d12", border: "1px solid #7c3aed", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.7)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid var(--cb-border)" }}>
              <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.15em", color: "#a78bfa", textTransform: "uppercase" }}>Ongoing Tournaments</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="cb-btn" style={{ padding: "4px 10px", fontSize: 11 }} onClick={fetchOngoing} disabled={ongoingLoading}>{ongoingLoading ? "..." : "Refresh"}</button>
                <button className="cb-btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setShowOngoing(false)}>X</button>
              </div>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              {ongoingSessions.length === 0 && (
                <div style={{ padding: 24, textAlign: "center", color: "var(--cb-muted)", fontSize: 13 }}>{ongoingLoading ? "Loading..." : "No active tournaments"}</div>
              )}
              {ongoingSessions.map((s) => (
                <div key={s.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid #15151c", background: s.code === sessionCode ? "rgba(124,58,237,0.12)" : undefined }}>
                  <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => joinByCode(s.code)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#e5e5f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name || "Untitled"}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "#c4b5fd", letterSpacing: "0.1em" }}>{s.code}</span>
                      {s.code === sessionCode && <span style={{ fontSize: 9, color: "#34d399", border: "1px solid #10b981", padding: "1px 5px" }}>CURRENT</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--cb-muted)", marginTop: 2 }}>
                      {[s.size ? `${s.size} teams` : null, s.mode ? (s.mode === "double" ? "Double Elim" : "Single Elim") : null, s.host || null, s.updatedAt ? timeAgo(s.updatedAt) : null].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <button className="cb-btn" style={{ padding: "3px 10px", fontSize: 11, borderColor: "#06b6d4", color: "#22d3ee" }} onClick={() => joinByCode(s.code)}>Open</button>
                  <button className="cb-btn" style={{ padding: "3px 9px", fontSize: 14, lineHeight: 1, borderColor: "#ef4444", color: "#f87171" }} title="Delete tournament" onClick={() => requestDeleteSession(s.code)}>×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Live indicator */}
      {isLive && screen === "bracket" && !screenshotMode && (
        <div style={{ position: "fixed", top: 10, right: 16, zIndex: 9999, display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,0.85)", border: "1px solid #22c55e", padding: "4px 10px", fontSize: 11, color: "#22c55e", letterSpacing: 1 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", animation: "livePulse 1.4s ease-in-out infinite" }} />
          LIVE
        </div>
      )}

      {/* Action Bar */}
      {screen === "bracket" && !screenshotMode && (
        <div className="action-bar">
          <button className="cb-btn" onClick={handleReset}>Reset Results</button>
          <button className="cb-btn" onClick={handleNewTournament}>New Tournament</button>
          <button className="cb-btn" style={{ borderColor: "#7c3aed", color: "#a78bfa" }} onClick={() => { setShowOngoing(true); fetchOngoing(); }}>Ongoing{ongoingSessions.length ? ` (${ongoingSessions.length})` : ""}</button>
          <button className="cb-btn"
            style={{ borderColor: publishStatus === "ok" ? "#22c55e" : publishStatus === "error" ? "#ef4444" : "#7c3aed", color: publishStatus === "ok" ? "#22c55e" : publishStatus === "error" ? "#ef4444" : "#a78bfa", opacity: publishStatus === "publishing" ? 0.6 : 1 }}
            disabled={publishStatus === "publishing"} onClick={() => publishBracket(pods)}>
            {publishStatus === "publishing" ? "Publishing..." : publishStatus === "ok" ? "Published" : publishStatus === "error" ? "Failed" : "Publish"}
          </button>
          {isLive && (
            <button className="cb-btn" style={{ borderColor: "#ef4444", color: "#f87171" }} onClick={unpublishBracket}>Unpublish</button>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--cb-muted)", cursor: "pointer", userSelect: "none" }}>
            <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} style={{ accentColor: "#7c3aed" }} />
            Auto-publish
          </label>
          <button className="cb-btn" onClick={handleScreenshot}>Screenshot Mode</button>
          <button className="cb-btn" onClick={handleCompact} style={compactMode ? { borderColor: "#9b6dff", color: "#9b6dff" } : undefined}>{compactMode ? "Normal" : "Compact"}</button>
          <button className="cb-btn" onClick={handleExportPng} style={{ borderColor: "#10b981", color: "#34d399" }}>Export PNG</button>
          <button className="cb-btn" style={{ borderColor: "#f59e0b", color: "#fbbf24" }} onClick={() => setShowSavePanel(true)}>...</button>
          {/* Session chip */}
          {sessionCode && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(124,58,237,0.12)", border: "1px solid #7c3aed", padding: "4px 10px", fontSize: 11, letterSpacing: "0.08em" }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0,
                background: syncStatus === "synced" ? "#22c55e" : syncStatus === "syncing" ? "#f59e0b" : syncStatus === "conflict" ? "#ef4444" : "#555566",
                boxShadow: syncStatus === "syncing" ? "0 0 6px #f59e0b" : undefined,
              }} />
              <span style={{ color: "#c4b5fd", fontWeight: 700 }}>{sessionCode}</span>
              {lastEditor && <span style={{ color: "var(--cb-muted)" }}>by {lastEditor}</span>}
              <button className="cb-btn" style={{ padding: "2px 7px", fontSize: 10, borderColor: "#10b981", color: "#34d399" }} onClick={() => { navigator.clipboard.writeText(`https://rauder999.github.io/codebreakers-bracket/live.html?session=${sessionCode}`); toast.success("Live link copied!"); }}>Live Link</button>
              <button className="cb-btn" style={{ padding: "2px 7px", fontSize: 10, borderColor: "#555566", color: "var(--cb-muted)" }} onClick={handleLeaveSession}>Leave</button>
            </div>
          )}
          <span style={{ fontSize: 10, color: "#444455", letterSpacing: "0.04em", marginLeft: 4 }}>Ctrl+Z undo · Ctrl+Y redo</span>
        </div>
      )}

      {/* Match History Panel */}
      {showHistory && (
        <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 340, background: "#0a0a0a", borderLeft: "1px solid var(--cb-border)", zIndex: 900, display: "flex", flexDirection: "column", fontFamily: "'Saira Condensed', sans-serif", boxShadow: "-4px 0 24px rgba(0,0,0,0.6)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--cb-border)" }}>
            <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.15em", color: "#22d3ee", textTransform: "uppercase" }}>Match History</span>
            <button className="cb-btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setShowHistory(false)}>X</button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
            {(() => {
              const completed = pods.filter((pod) => pod.teams.some((t) => t.name && t.placement !== 0) && pod.teams.filter((t) => t.name).length >= 2);
              if (completed.length === 0) return <div style={{ color: "var(--cb-muted)", fontSize: 13, textAlign: "center", padding: 32 }}>No results yet</div>;
              return completed.map((pod) => {
                const sorted = [...pod.teams].filter((t) => t.name && t.placement !== 0).sort((a, b) => a.placement - b.placement);
                const isComplete = pod.teams.filter((t) => t.name).every((t) => t.placement !== 0);
                return (
                  <div key={pod.id} style={{ marginBottom: 12, background: "#141414", border: "1px solid var(--cb-border)", padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--cb-muted)", marginBottom: 6, textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
                      <span>{pod.label}</span>
                      {!isComplete && <span style={{ color: "#f59e0b" }}>partial</span>}
                    </div>
                    {sorted.map((t) => (
                      <div key={t.name + t.placement} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px solid #1a1a1a" }}>
                        <span style={{ fontSize: 13, minWidth: 24, color: t.placement === 1 ? "#fbbf24" : t.placement === 2 ? "#94a3b8" : t.placement === 3 ? "#cd7c3a" : "var(--cb-muted)" }}>
                          {PLACEMENT_EMOJIS[t.placement as Placement] || `#${t.placement}`}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: t.placement === 1 ? 700 : 400, color: t.placement === 1 ? "var(--cb-text)" : "var(--cb-muted)" }}>{t.name}</span>
                      </div>
                    ))}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Save/Load Panel */}
      {showSavePanel && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setShowSavePanel(false)}>
          <div style={{ background: "#0f0f0f", border: "1px solid var(--cb-border)", padding: 24, minWidth: 420, maxWidth: 560, maxHeight: "80vh", overflow: "auto", fontFamily: "'Saira Condensed', sans-serif" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.15em", color: "#fbbf24", textTransform: "uppercase" }}>Tournaments</span>
              <button className="cb-btn" onClick={() => setShowSavePanel(false)}>X Close</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input value={saveNameInput} onChange={(e) => setSaveNameInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSaveTournament()} placeholder="Save name (optional)..."
                style={{ flex: 1, background: "#1a1a1a", border: "1px solid var(--cb-border)", color: "var(--cb-text)", padding: "8px 12px", fontSize: 13, fontFamily: "'Saira Condensed', sans-serif", outline: "none" }} />
              <button className="cb-btn" style={{ borderColor: "#22c55e", color: "#4ade80" }} onClick={handleSaveTournament}>Save</button>
            </div>
            {saves.length === 0 ? (
              <div style={{ color: "var(--cb-muted)", fontSize: 13, textAlign: "center", padding: 24 }}>No saved tournaments yet</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {saves.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#1a1a1a", border: "1px solid var(--cb-border)", padding: "8px 12px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cb-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: "var(--cb-muted)", marginTop: 2 }}>
                        {s.tournamentMode === "double" ? "DE" : "SE"} · {s.tournamentSize} teams · {s.screen === "bracket" ? "In progress" : "Setup"} · {new Date(s.savedAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <button className="cb-btn" style={{ borderColor: "#7c3aed", color: "#a78bfa", padding: "6px 12px", fontSize: 11 }} onClick={() => handleLoadTournament(s)}>Load</button>
                    <button className="cb-btn" style={{ borderColor: "#ef4444", color: "#f87171", padding: "6px 12px", fontSize: 11 }} onClick={() => handleDeleteSave(s.id)}>X</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connector legend */}
      {screen === "bracket" && !screenshotMode && (
        <div style={{ position: "fixed", bottom: 16, left: 16, zIndex: 200, background: "rgba(10,10,12,0.85)", border: "1px solid var(--cb-border)", padding: "8px 12px", fontSize: 10, color: "var(--cb-muted)", letterSpacing: "0.06em", display: "flex", flexDirection: "column", gap: 5, backdropFilter: "blur(4px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="28" height="4" viewBox="0 0 28 4"><line x1="0" y1="2" x2="28" y2="2" stroke="#22c55e" strokeWidth="2"/></svg>
            <span>Advances</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="28" height="4" viewBox="0 0 28 4"><line x1="0" y1="2" x2="28" y2="2" stroke="#f97316" strokeWidth="2" strokeDasharray="4 3"/></svg>
            <span>Drops to LB</span>
          </div>
        </div>
      )}
      {screen === "bracket" && screenshotMode && (
        <div className="screenshot-exit-bar">
          <button className="cb-btn primary" onClick={handleScreenshot}>X Exit Screenshot</button>
        </div>
      )}
    </div>
  );
}

// ─── FormatPhaseRow ───────────────────────────────────────────────────────────

import type { PhaseSpec } from "../lib/bracketEngine";

interface FormatPhaseRowProps {
  phase: PhaseSpec;
  formatConfig: FormatConfig;
  globalFormat: PodSize;
  setFormatConfig: React.Dispatch<React.SetStateAction<FormatConfig>>;
}

function FormatPhaseRow({ phase, formatConfig, globalFormat, setFormatConfig }: FormatPhaseRowProps) {
  const override = formatConfig[phase.id];
  const effective = override ?? globalFormat;
  // Structurally forced phases (e.g. Cash-Out when Head-to-Head Semis is on)
  // can't be reformatted; show them locked.
  if (phase.forcePodSize) {
    return (
      <div className="format-phase-row">
        <span className="format-phase-label" style={{ color: "var(--cb-muted)" }}>{phase.label}</span>
        <span style={{ fontSize: 11, color: "var(--cb-muted)", letterSpacing: "0.05em" }}>{phase.forcePodSize}-TEAM (locked)</span>
      </div>
    );
  }
  return (
    <div className="format-phase-row">
      <span className="format-phase-label">{phase.label}</span>
      <div className="format-toggle-group small">
        <button
          className={`format-toggle-btn small${effective === 4 && !override ? " active global" : effective === 4 ? " active" : ""}`}
          onClick={() => setFormatConfig(prev => ({ ...prev, [phase.id]: 4 }))}
        >4</button>
        <button
          className={`format-toggle-btn small${effective === 2 && !override ? " active global" : effective === 2 ? " active" : ""}`}
          onClick={() => setFormatConfig(prev => ({ ...prev, [phase.id]: 2 }))}
        >2</button>
        {override !== undefined && (
          <button
            className="format-toggle-btn small reset"
            onClick={() => setFormatConfig(prev => { const n = { ...prev }; delete n[phase.id]; return n; })}
            title="Reset to global"
          >~</button>
        )}
      </div>
    </div>
  );
}

// ─── MatchPod ─────────────────────────────────────────────────────────────────

interface MatchPodProps {
  pod: Pod;
  isGF: boolean;
  isDE: boolean;
  isLB?: boolean;
  onTeamClick: (podId: string, teamIdx: number) => void;
  onMapClick: (podId: string) => void;
  onStreamToggle: (podId: string) => void;
  screenshotMode: boolean;
}

function MatchPod({ pod, isGF, isDE, isLB, onTeamClick, onMapClick, onStreamToggle, screenshotMode }: MatchPodProps) {
  const podClass = ["match-pod", isGF ? "gf-pod" : "", isLB ? "lb-pod" : "", pod.liveNow ? "live-now" : "", pod.onStream && !pod.liveNow ? "on-stream" : ""].filter(Boolean).join(" ");
  const headerClass = ["pod-header", isGF ? "gf-header" : "", isLB ? "lb-header" : ""].filter(Boolean).join(" ");

  const streamTitle = pod.liveNow
    ? "Live now (click to clear)"
    : pod.onStream
      ? "Planned for stream (click to set Live now)"
      : "Mark for stream";

  return (
    <div className={podClass} data-pod-id={pod.id}>
      <div className={headerClass}>
        <span>{pod.label}</span>
        {!screenshotMode && (
          <button
            className={`stream-toggle${pod.liveNow ? " live" : pod.onStream ? " active" : ""}`}
            onClick={(e) => { e.stopPropagation(); onStreamToggle(pod.id); }}
            title={streamTitle}
          >📹</button>
        )}
        {pod.liveNow && screenshotMode && <span className="stream-badge-static">📹 LIVE</span>}
        {pod.onStream && !pod.liveNow && screenshotMode && <span className="stream-badge-planned">📹</span>}
      </div>

      {/* Map plate */}
      <div
        className="map-plate"
        onClick={() => onMapClick(pod.id)}
        title="Click to change map"
      >
        <span className="map-name">{pod.map ?? "- map -"}</span>
      </div>

      {pod.teams.map((team, ti) => {
        const isChampion = isGF && team.placement === 1 && !!team.name;
        const podSize = pod.teams.length;
        const advanceCount = podSize / 2;
        const isAdvancing = !isGF && team.placement >= 1 && team.placement <= advanceCount;
        const isDropping = isDE && !isLB && !isGF && !pod.hasNoLBDrop && team.placement > advanceCount && team.placement <= podSize;
        const isEliminated = !isGF && (
          (isLB && team.placement > advanceCount) ||
          (!isDE && team.placement > advanceCount) ||
          (isDE && pod.hasNoLBDrop && team.placement > advanceCount)
        );
        const isEmpty = !team.name;

        let rowClass = "team-row";
        if (isChampion) rowClass += " champion";
        else if (isAdvancing) rowClass += " advancing";
        else if (isDropping) rowClass += " dropping";
        else if (isEliminated) rowClass += " eliminated";

        const emoji = isChampion ? "👑" : (PLACEMENT_EMOJIS[team.placement as Placement] || "");
        const placementLabel = team.placement !== 0 ? `[${PLACEMENT_LABELS[team.placement as Placement]}]` : "";

        return (
          <div key={ti} className={rowClass} onClick={() => !isEmpty && onTeamClick(pod.id, ti)} title={isEmpty ? "" : "Click to set result"}>
            {!isGF && (
              <span className="team-seed-group">
                {team.seed > 0 ? <span className="team-seed">#{team.seed}</span> : null}
              </span>
            )}
            {isGF && isDE && team.path && (
              <span className={`path-badge ${team.path === "wb" ? "wb-badge" : "lb-badge"}`}>[{team.path.toUpperCase()}]</span>
            )}
            <span className="team-emoji">{emoji}</span>
            <span className="team-name" style={{ color: isEmpty ? "var(--cb-muted)" : undefined }}>
              {team.name || "-"}
            </span>
            {!screenshotMode && placementLabel && (
              <span className={`placement-badge${isChampion ? " champion-badge" : ""}`}>{placementLabel}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
