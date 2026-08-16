/*
 * DESIGN: Terminal Violet — dark terminal, 1px borders, no rounding.
 * Type: Space Grotesk (display) / Inter (text) / IBM Plex Mono (data).
 * Semantics: violet = brand, green = advance, orange = drop to LB,
 * red = LIVE, gold = champion, dimmed = eliminated. Tokens live in index.css.
 *
 * ENGINE: bracketEngine.ts - generative, per-phase format (2 or 4 teams)
 * MODES: Single Elimination / Double Elimination
 * FEATURES: per-stage format toggle, map plates, CSV import
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Video, Crown, GripVertical, X } from "lucide-react";
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
  "Bernal", "Fangwai City", "Fortune Stadium", "Galaxy Estates",
  "Las Vegas Stadium", "Monaco", "Nozomi/Citadel", "Skyway Stadium",
  "Sys$Horizon",
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
  tournamentStarted?: boolean;
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
const PLACEMENT_COLORS: Record<number, string> = { 1: "var(--cb-gold)", 2: "var(--cb-silver)", 3: "var(--cb-orange)" };

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
  rows: string[][], nameCol: number, strengthCol: number, playerCols: number[], discordCols: number[], size: Size
): SeedEntry[] {
  const teams = rows.slice(1).map(r => ({
    name: (r[nameCol] || "").trim(),
    strength: parseFloat(r[strengthCol]) || 0,
    // A cell may hold one entry or a comma-separated list - accept both.
    players: playerCols.flatMap(c => (r[c] || "").split(",")).map(v => v.trim()).filter(Boolean),
    discords: discordCols.flatMap(c => (r[c] || "").split(",")).map(v => v.trim()).filter(Boolean),
  })).filter(t => t.name);
  teams.sort((a, b) => b.strength - a.strength);
  const result = teams.slice(0, size).map((t, i) => ({ name: t.name, seed: i + 1, players: t.players, discords: t.discords }));
  if (teams.length < size) {
    const pad = size - teams.length;
    for (let i = 0; i < pad; i++) result.push({ name: `TBD ${i + 1}`, seed: result.length + 1, players: [], discords: [] });
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

function shortLabel(l: string): string {
  return l
    .replace("GROUP STAGE", "GROUPS").replace("QUARTERFINALS", "QUARTERS")
    .replace("SEMIFINALS", "SEMIS").replace("SEMIFINAL", "SEMI")
    .replace("CASH-OUT FINAL", "CASH-OUT").replace("GRAND FINAL", "GRAND F.")
    .replace("ROUND ", "R");
}

// Live SVG preview of the bracket structure. Green solid = advances to the next
// round; orange dashed = losers dropping from a Winners block into the Losers
// Bracket. N×K on a node means N matches of K teams each.
function BracketPreview({ size, mode, opts, config }: { size: Size; mode: TournamentMode; opts: EngineOptions; config: FormatConfig }) {
  const [hover, setHover] = useState<string | null>(null);
  const graph = getPhaseGraph(size, mode, opts);
  const psOf = (p: Parameters<typeof effectivePodSize>[0]) => effectivePodSize(p, config);
  const pcOf = (p: Parameters<typeof effectivePodSize>[0]) => p.id === "fbracket" ? 2 : Math.max(1, Math.ceil(p.inputCount / psOf(p)));

  const top = graph.filter((p) => p.bracket === "wb" || p.bracket === "gf");
  const bot = graph.filter((p) => p.bracket === "lb");
  // Roomier geometry — the preview panel is a proper sidebar now, so nodes can breathe.
  const colW = 104, nodeW = 82, nodeH = 44, marginX = 16, topY = 40;
  const botY = bot.length ? topY + 150 : topY;
  type P = { x: number; y: number; w: number; h: number; cx: number; cy: number };
  const pos: Record<string, P> = {};
  top.forEach((p, i) => { const x = marginX + i * colW; pos[p.id] = { x, y: topY, w: nodeW, h: nodeH, cx: x + nodeW / 2, cy: topY + nodeH / 2 }; });
  bot.forEach((p, i) => { const x = marginX + i * colW; pos[p.id] = { x, y: botY, w: nodeW, h: nodeH, cx: x + nodeW / 2, cy: botY + nodeH / 2 }; });
  const width = marginX * 2 + Math.max(top.length, bot.length, 1) * colW;
  const height = botY + nodeH + 16;

  const adv: [string, string][] = [];
  const drop: [string, string][] = [];
  for (const p of graph) {
    if (p.advanceTo && pos[p.advanceTo]) adv.push([p.id, p.advanceTo]);
    if (mode === "double" && p.dropTo && !p.hasNoLBDrop && pos[p.dropTo]) drop.push([p.id, p.dropTo]);
  }
  const strokeFor = (b: string) => b === "gf" ? "#e8b64a" : b === "lb" ? "#ff8a3d" : "#7c5cff";

  // Hover: light up the hovered node and the nodes its teams flow into.
  const hoverPhase = hover ? graph.find((p) => p.id === hover) : null;
  const lit = new Set<string>();
  if (hoverPhase) {
    lit.add(hoverPhase.id);
    if (hoverPhase.advanceTo && pos[hoverPhase.advanceTo]) lit.add(hoverPhase.advanceTo);
    if (mode === "double" && hoverPhase.dropTo && !hoverPhase.hasNoLBDrop && pos[hoverPhase.dropTo]) lit.add(hoverPhase.dropTo);
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: "block" }} fontFamily="'IBM Plex Mono', monospace">
        <text x={marginX} y={topY - 14} fill="#a48fff" fontSize={9} letterSpacing={2}>WINNERS BRACKET → FINALS</text>
        {bot.length > 0 && <text x={marginX} y={botY - 14} fill="#ff8a3d" fontSize={9} letterSpacing={2}>LOSERS BRACKET</text>}
        {adv.map(([a, b], i) => {
          const s = pos[a], t = pos[b];
          const hot = hover === a;
          const dim = hover !== null && !hot;
          return <path key={"a" + i} d={`M ${s.x + s.w} ${s.cy} C ${s.x + s.w + 22} ${s.cy}, ${t.x - 22} ${t.cy}, ${t.x} ${t.cy}`}
            stroke="#28d17c" strokeWidth={hot ? 2.6 : 1.4} fill="none"
            opacity={dim ? 0.12 : hot ? 1 : 0.6}
            style={{ filter: hot ? "drop-shadow(0 0 4px rgba(40,209,124,0.7))" : undefined, transition: "opacity 120ms, stroke-width 120ms" }} />;
        })}
        {drop.map(([a, b], i) => {
          const s = pos[a], t = pos[b]; const my = (s.y + s.h + t.y) / 2;
          const hot = hover === a;
          const dim = hover !== null && !hot;
          return <path key={"d" + i} d={`M ${s.cx} ${s.y + s.h} C ${s.cx} ${my}, ${t.cx} ${my}, ${t.cx} ${t.y}`}
            stroke="#ff8a3d" strokeWidth={hot ? 2.4 : 1.4} strokeDasharray="4 3" fill="none"
            opacity={dim ? 0.12 : hot ? 1 : 0.8}
            style={{ filter: hot ? "drop-shadow(0 0 4px rgba(255,138,61,0.7))" : undefined, transition: "opacity 120ms, stroke-width 120ms" }} />;
        })}
        {graph.map((p) => {
          const n = pos[p.id]; if (!n) return null;
          const c = strokeFor(p.bracket);
          const isLit = lit.has(p.id);
          const dim = hover !== null && !isLit;
          return (
            <g key={p.id} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={0}
                fill={isLit ? c + "3a" : c + "1e"} stroke={c}
                strokeWidth={isLit ? 1.8 : 1}
                opacity={dim ? 0.35 : 1}
                style={{ filter: hover === p.id ? `drop-shadow(0 0 6px ${c}aa)` : undefined, transition: "all 120ms" }} />
              <text x={n.cx} y={n.y + 17} textAnchor="middle" fill="#dfe3ef" fontSize={8} opacity={dim ? 0.4 : 1}>{shortLabel(p.label)}</text>
              <text x={n.cx} y={n.y + 33} textAnchor="middle" fill={c === "#7c5cff" ? "#a48fff" : c} fontSize={11} fontWeight={600} opacity={dim ? 0.4 : 1}>{pcOf(p)}×{psOf(p)}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 10, color: "var(--cb-muted)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><svg width={20} height={4}><line x1={0} y1={2} x2={20} y2={2} stroke="#28d17c" strokeWidth={2.4} /></svg>advances</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><svg width={20} height={4}><line x1={0} y1={2} x2={20} y2={2} stroke="#ff8a3d" strokeWidth={2.4} strokeDasharray="4 3" /></svg>drops to losers</span>
      </div>
      <div style={{ fontFamily: "var(--cb-font-mono)", fontSize: 9.5, color: "var(--cb-purple2)", opacity: 0.85, marginTop: 10, lineHeight: 1.5, letterSpacing: "0.03em" }}>▸ Hover a match to trace where its teams go.</div>
      <div style={{ fontSize: 10, color: "var(--cb-muted)", opacity: 0.7, marginTop: 4, lineHeight: 1.4 }}>Teams fill in after you generate.</div>
    </div>
  );
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
  // Gate for Discord automation: until the host presses Start Tournament, the
  // bot stays silent (no pings, no match threads).
  const [tournamentStarted, setTournamentStarted] = useState<boolean>(_as?.tournamentStarted ?? false);
  const [showStartConfirm, setShowStartConfirm] = useState(false);
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
  const [csvDiscordCols, setCsvDiscordCols] = useState<number[]>([]);
  // Notion registrations import
  const [notionTag, setNotionTag] = useState("");
  const [notionLoading, setNotionLoading] = useState(false);
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
  const WORKER_URL = "https://codebreakers-api.codebreakerstf.workers.dev";
  const WS_URL = WORKER_URL.replace(/^http/, "ws");
  const [isLive, setIsLive] = useState(false);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing" | "ok" | "error">("idle");
  const [autoPublish, setAutoPublish] = useState(false);
  const autoPublishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // adminToken now holds the auth credential sent to the worker: either the
  // super-admin master password OR a signed account token (organizer). Persisted
  // to localStorage so organizers stay signed in across restarts.
  const [adminToken, setAdminToken] = useState<string>(() => localStorage.getItem("cb_auth_token") || sessionStorage.getItem("cb_admin_token") || "");
  const [authKind, setAuthKind] = useState<string>(() => localStorage.getItem("cb_auth_kind") || "");
  const [authName, setAuthName] = useState<string>(() => localStorage.getItem("cb_auth_name") || "");
  const [showTokenDialog, setShowTokenDialog] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register" | "master">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [fLoginName, setFLoginName] = useState("");
  const [fLoginPass, setFLoginPass] = useState("");
  const [fRegInvite, setFRegInvite] = useState("");
  const [fRegName, setFRegName] = useState("");
  const [fRegPass, setFRegPass] = useState("");
  const applyAuth = useCallback((token: string, kind: string, name: string) => {
    setAdminToken(token); setAuthKind(kind); setAuthName(name);
    localStorage.setItem("cb_auth_token", token);
    localStorage.setItem("cb_auth_kind", kind);
    localStorage.setItem("cb_auth_name", name);
    sessionStorage.setItem("cb_admin_token", token);
  }, []);
  const logout = useCallback(() => {
    setAdminToken(""); setAuthKind(""); setAuthName("");
    localStorage.removeItem("cb_auth_token");
    localStorage.removeItem("cb_auth_kind");
    localStorage.removeItem("cb_auth_name");
    sessionStorage.removeItem("cb_admin_token");
    toast("Signed out", { duration: 1500 });
  }, []);
  const pendingAction = useRef<"publish" | "unpublish" | "generate-session" | "delete-session" | null>(null);
  const pendingGenState = useRef<string | null>(null);
  const pendingDeleteCode = useRef<string | null>(null);
  const [ongoingSessions, setOngoingSessions] = useState<OngoingSession[]>([]);
  const [showOngoing, setShowOngoing] = useState(false);
  const [ongoingLoading, setOngoingLoading] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [invitesList, setInvitesList] = useState<{ code: string; note: string; usedBy: string | null; createdAt: string | null }[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [newInviteNote, setNewInviteNote] = useState("");
  // Archive (frozen snapshot of a finished tournament)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  // Raw text of roster inputs while focused — otherwise the controlled value
  // re-parses on every keystroke and eats trailing commas/spaces.
  const [rosterDrafts, setRosterDrafts] = useState<Record<string, string>>({});
  // In-tournament roster editor: substitute players / fix discords / rename a
  // team without leaving the bracket screen or regenerating the session.
  const [showTeamEditor, setShowTeamEditor] = useState(false);
  const [teamDrafts, setTeamDrafts] = useState<{ name: string; players: string; discords: string }[]>([]);
  const clearRosterDraft = (key: string) => setRosterDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });
  const [previewWide, setPreviewWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1600);
  useEffect(() => {
    const onResize = () => setPreviewWide(window.innerWidth >= 1600);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
    const data: Partial<SavedTournament> = { screen, tournamentSize, tournamentMode, seeds, pods, formatConfig, globalFormat, finalsBracket, tournamentStarted };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
  }, [screen, tournamentSize, tournamentMode, seeds, pods, formatConfig, globalFormat, finalsBracket, tournamentStarted]);

  // Undo/redo
  const setPodsWithHistory = useCallback((updater: Pod[] | ((prev: Pod[]) => Pod[])) => {
    setPods((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      undoStack.current = [...undoStack.current.slice(-MAX_HISTORY + 1), prev];
      redoStack.current = [];
      return next;
    });
  }, []);

  // Serialize a full snapshot with explicit pods — used to sync undo/redo, which
  // replace the whole pods array rather than sending a single per-match mutation.
  const buildStateWithPods = useCallback((podsArg: Pod[]) => JSON.stringify({ pods: podsArg, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, tournamentStarted, screen }), [tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, tournamentStarted, screen]);
  const buildStateWithPodsRef = useRef(buildStateWithPods);
  buildStateWithPodsRef.current = buildStateWithPods;

  const handleUndo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current[undoStack.current.length - 1];
    undoStack.current = undoStack.current.slice(0, -1);
    setPods((cur) => { redoStack.current = [...redoStack.current, cur]; return prev; });
    if (sessionCodeRef.current) sendMutation({ t: "full-state", state: buildStateWithPodsRef.current(prev) });
    toast("Undo", { description: "Last action undone", duration: 1500 });
  }, [sendMutation]);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current[redoStack.current.length - 1];
    redoStack.current = redoStack.current.slice(0, -1);
    setPods((cur) => { undoStack.current = [...undoStack.current, cur]; return next; });
    if (sessionCodeRef.current) sendMutation({ t: "full-state", state: buildStateWithPodsRef.current(next) });
    toast("Redo", { description: "Action re-applied", duration: 1500 });
  }, [sendMutation]);

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

  const runPendingAuthAction = (token: string) => {
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

  const handleTokenSubmit = async () => {
    setTokenError("");
    setAuthBusy(true);
    try {
      let token = "", kind = "account", name = "";
      if (authMode === "master") {
        token = tokenInput.trim();
        if (!token) { setTokenError("Enter the master password"); setAuthBusy(false); return; }
        const res = await fetch(`${WORKER_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await res.json().catch(() => ({}));
        if (!d.ok || d.kind !== "master") { setTokenError("Wrong master password"); setAuthBusy(false); return; }
        kind = "master"; name = "Super-admin";
      } else if (authMode === "login") {
        const res = await fetch(`${WORKER_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: fLoginName.trim(), password: fLoginPass }) });
        const d = await res.json().catch(() => ({}));
        if (!d.ok) { setTokenError(d.error || "Login failed"); setAuthBusy(false); return; }
        token = d.token; name = d.name;
      } else {
        const res = await fetch(`${WORKER_URL}/auth/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invite: fRegInvite.trim(), name: fRegName.trim(), password: fRegPass }) });
        const d = await res.json().catch(() => ({}));
        if (!d.ok) { setTokenError(d.error || "Registration failed"); setAuthBusy(false); return; }
        token = d.token; name = d.name;
      }
      applyAuth(token, kind, name);
      setShowTokenDialog(false);
      setTokenInput(""); setFLoginPass(""); setFRegPass("");
      toast.success(kind === "master" ? "Signed in as Super-admin" : `Signed in as ${name}`);
      runPendingAuthAction(token);
    } catch {
      setTokenError("Network error — try again");
    }
    setAuthBusy(false);
  };

  // ─── Session helpers ──────────────────────────────────────────────────────────

  const buildSessionState = useCallback(() => JSON.stringify({ pods, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, tournamentStarted, screen }), [pods, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, tournamentStarted, screen]);
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
      if (s.tournamentStarted !== undefined) setTournamentStarted(s.tournamentStarted);
      // NOTE: `screen` is intentionally NOT adopted — it's local navigation.
      // Adopting it here yanked the operator back to Home on every sync.
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
        if (code !== sessionCodeRef.current) return; // stale socket from a previous session
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
      const res = await fetch(`${WORKER_URL}/sessions/active`, adminToken ? { headers: { Authorization: `Bearer ${adminToken}` } } : undefined);
      const data = await res.json() as { ok: boolean; sessions: OngoingSession[] };
      if (data.ok) setOngoingSessions(data.sessions || []);
    } catch { /* ignore */ } finally { setOngoingLoading(false); }
  }, [adminToken]);

  // ─── Invites (super-admin) ────────────────────────────────────────────────
  const fetchInvites = useCallback(async () => {
    setInvitesLoading(true);
    try {
      const res = await fetch(`${WORKER_URL}/invites`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const d = await res.json() as { ok: boolean; invites: { code: string; note: string; usedBy: string | null; createdAt: string | null }[] };
      if (d.ok) setInvitesList(d.invites || []);
    } catch { /* ignore */ } finally { setInvitesLoading(false); }
  }, [adminToken]);

  const mintInvite = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/invites`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ note: newInviteNote }) });
      const d = await res.json() as { ok: boolean; code?: string; error?: string };
      if (d.ok && d.code) { setNewInviteNote(""); navigator.clipboard.writeText(d.code); toast.success(`Invite ${d.code} created & copied`); fetchInvites(); }
      else toast.error(d.error || "Failed to create invite");
    } catch { toast.error("Network error"); }
  }, [adminToken, newInviteNote, fetchInvites]);

  // Generate a co-host edit link for the current session and copy it.
  const shareSession = useCallback(async (code: string) => {
    try {
      const res = await fetch(`${WORKER_URL}/session/${code}/share`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } });
      const d = await res.json() as { ok: boolean; code?: string; token?: string; error?: string };
      if (!d.ok || !d.token) { toast.error(d.error || "Failed to create share link"); return; }
      const link = `https://rauder999.github.io/codebreakers-bracket/?cohost=${encodeURIComponent(d.token)}&session=${d.code}`;
      navigator.clipboard.writeText(link);
      toast.success("Co-host edit link copied — send it to your helper", { duration: 4000 });
    } catch { toast.error("Network error"); }
  }, [adminToken]);

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
    if (!window.confirm(`Delete tournament ${code}? This permanently removes it and cannot be undone.`)) return;
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
  // Co-host link on mount: ?cohost=<token>&session=<code> grants write access to
  // one tournament without an account. Takes precedence over auto-rejoin.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cohost = params.get("cohost");
    const sess = params.get("session");
    if (cohost && sess) {
      applyAuth(cohost, "cohost", "Co-host");
      window.history.replaceState({}, "", window.location.pathname);
      joinByCode(sess);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-rejoin session on mount if sessionStorage has a code
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("cohost")) return; // handled above
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
    // Mini-brackets are structurally single-elimination.
    if (s < 8) { setTournamentMode("single"); setFinalsBracket(false); }
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
    // ALWAYS start a fresh session. Any previous tournament stays on the server
    // (visible in Connect to Session) until deleted, and never mixes into this one.
    setTournamentStarted(false); // a fresh bracket is always un-started
    const stateStr = JSON.stringify({ pods: initial, tournamentSize, tournamentMode, seeds: normalised, formatConfig, globalFormat, finalsBracket, tournamentStarted: false, screen: "bracket" });
    if (adminToken) {
      createSessionForState(stateStr, adminToken);
    } else {
      pendingGenState.current = stateStr;
      pendingAction.current = "generate-session";
      setTokenInput("");
      setTokenError("");
      setShowTokenDialog(true);
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
      doPutSession(sessionCodeRef.current, JSON.stringify({ pods: withMaps, tournamentSize, tournamentMode, seeds: normalised, formatConfig, globalFormat, finalsBracket, tournamentStarted, screen: "bracket" }), adminToken);
    }
  };

  // Freeze the current tournament as an immutable server-side archive.
  const archiveChampion = pods.find((p) => p.phase === "gf")?.teams.find((t) => t.placement === 1)?.name || null;
  const handleArchiveTournament = async () => {
    if (!adminToken) { toast.error("Sign in to archive a tournament"); return; }
    setArchiveBusy(true);
    try {
      const stateStr = JSON.stringify({ pods, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, tournamentStarted, tournamentName: tournamentNameRef.current, screen: "bracket" });
      const res = await fetch(`${WORKER_URL}/archives`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ state: stateStr, name: tournamentNameRef.current || "Untitled Tournament", size: tournamentSize, mode: tournamentMode, champion: archiveChampion }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const link = `https://rauder999.github.io/codebreakers-bracket/live.html?archive=${data.id}`;
      try { await navigator.clipboard.writeText(link); } catch { /* clipboard optional */ }
      toast.success(`Archived as ${data.id} — public link copied`, { duration: 5000 });
      setShowArchiveConfirm(false);
    } catch (e) {
      toast.error(`Archive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setArchiveBusy(false);
  };

  // Flips the Discord automation on: the bot pings round-1 teams and opens
  // their match threads the moment this state reaches the server.
  const handleStartTournament = () => {
    setTournamentStarted(true);
    setShowStartConfirm(false);
    const stateStr = JSON.stringify({ pods, tournamentSize, tournamentMode, seeds, formatConfig, globalFormat, finalsBracket, tournamentStarted: true, screen: "bracket" });
    if (sessionCodeRef.current && adminToken) {
      doPutSession(sessionCodeRef.current, stateStr, adminToken);
      toast.success("Tournament started — Discord pings and match threads are going out", { duration: 4000 });
    } else {
      toast.warning("No live session — connect or generate one first");
    }
  };

  const handleNewTournament = () => {
    setScreen("setup");
    setScreenshotMode(false);
    document.body.classList.remove("screenshot-mode");
  };

  const openTeamEditor = () => {
    setTeamDrafts(seeds.map((s) => ({ name: s.name, players: (s.players ?? []).join(", "), discords: (s.discords ?? []).join(", ") })));
    setShowTeamEditor(true);
  };

  // Apply roster edits to the live tournament: seeds AND every pod slot that
  // references the team (pods carry the name and a copy of players for the
  // live-page tooltip). One full-state PUT so live viewers and the Discord bot
  // pick the change up immediately.
  const handleTeamEditorSave = () => {
    const renames = new Map<string, string>();
    const playersByName = new Map<string, string[]>();
    const newSeeds = seeds.map((s, i) => {
      const d = teamDrafts[i];
      if (!d) return s;
      const name = (d.name.trim() || s.name).slice(0, 24);
      const players = d.players.split(",").map((x) => x.trim()).filter(Boolean);
      const discords = d.discords.split(",").map((x) => x.trim()).filter(Boolean);
      if (s.name && name !== s.name) renames.set(s.name, name);
      if (name) playersByName.set(name, players);
      return { ...s, name, players, discords };
    });
    const newPods = pods.map((p) => ({
      ...p,
      teams: p.teams.map((t) => {
        if (!t.name) return t;
        const nn = renames.get(t.name) ?? t.name;
        return { ...t, name: nn, players: playersByName.get(nn) ?? t.players };
      }),
    }));
    setSeeds(newSeeds);
    setPods(newPods);
    setShowTeamEditor(false);
    const stateStr = JSON.stringify({ pods: newPods, tournamentSize, tournamentMode, seeds: newSeeds, formatConfig, globalFormat, finalsBracket, tournamentStarted, screen: "bracket" });
    if (sessionCodeRef.current && adminToken) {
      doPutSession(sessionCodeRef.current, stateStr, adminToken);
      toast.success("Teams updated — live page and Discord bot are in sync");
    } else {
      toast.success("Teams updated locally");
    }
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
      const canvas = await html2canvas(el, { backgroundColor: "#08090c", scale: 2, useCORS: true, logging: false });
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

  // Pull registrations from the Notion form database into the seed list.
  const handleNotionImport = async () => {
    if (!adminToken) { toast.error("Sign in to import from Notion"); return; }
    setNotionLoading(true);
    try {
      const qs = notionTag.trim() ? `?tournament=${encodeURIComponent(notionTag.trim())}` : "";
      const res = await fetch(`${WORKER_URL}/registrations${qs}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const teams: { name: string; players: string[]; discords: string[]; status: string; rank?: number | null }[] = data.teams || [];
      if (teams.length === 0) { toast.warning("No registrations found in Notion"); return; }
      // Seed by ranked score, highest first; teams without a rank go last in
      // submission order.
      teams.sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1));
      const result: SeedEntry[] = teams.slice(0, tournamentSize).map((t, i) => ({ name: t.name.slice(0, 24), seed: i + 1, players: t.players, discords: t.discords }));
      while (result.length < tournamentSize) result.push({ name: `TBD ${result.length + 1}`, seed: result.length + 1, players: [], discords: [] });
      setSeeds(result);
      const pending = teams.filter((t) => t.status === "Pending").length;
      const over = teams.length > tournamentSize ? ` (${teams.length - tournamentSize} over the limit, dropped)` : "";
      const ranked = teams.filter((t) => t.rank != null).length;
      toast.success(`Imported ${Math.min(teams.length, tournamentSize)} teams from Notion${ranked ? ` · seeded by rank (${ranked} ranked)` : ""}${over}${pending ? ` · ${pending} still Pending` : ""}`);
    } catch (e) {
      toast.error(`Notion import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setNotionLoading(false);
  };

  const handleCsvApply = () => {
    if (!csvRows) return;
    const newSeeds = seedsFromImport(csvRows, csvNameCol, csvStrengthCol, csvPlayerCols, csvDiscordCols, tournamentSize);
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
          {/* Top-right account toolbar — grouped into one cohesive bar */}
          <div style={{ position: "fixed", top: 12, right: 16, zIndex: 600, display: "flex", gap: 6, alignItems: "center", background: "rgba(13,15,20,0.92)", border: "1px solid var(--cb-border)", padding: "6px 8px", backdropFilter: "blur(8px)", boxShadow: "0 4px 16px rgba(0,0,0,0.45)" }}>
            <button className="cb-btn ghost" onClick={() => { navigator.clipboard.writeText("https://rauder999.github.io/codebreakers-bracket/live.html"); toast.success("Gallery link copied — shows all live tournaments"); }}>Gallery link</button>
            {pods.length > 0 && (
              <button className="cb-btn success" onClick={() => setScreen("bracket")}>← Back to tournament</button>
            )}
            {authKind === "master" && (
              <button className="cb-btn warn" onClick={() => { setShowInvites(true); fetchInvites(); }}>Invites</button>
            )}
            {adminToken ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 4, borderLeft: "1px solid var(--cb-border)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--cb-font-mono)", fontSize: 10.5, letterSpacing: "0.08em", color: "var(--cb-purple2)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cb-green)", boxShadow: "0 0 5px var(--cb-green)" }} />
                  {authKind === "master" ? "SUPER-ADMIN" : (authName || "SIGNED IN")}
                </span>
                <button className="cb-btn" style={{ padding: "4px 10px", fontSize: 10.5 }} onClick={logout}>Sign out</button>
              </span>
            ) : (
              <button className="cb-btn info" onClick={() => { pendingAction.current = null; setAuthMode("login"); setShowTokenDialog(true); }}>Sign in / Register</button>
            )}
          </div>
          {/* Live bracket preview — a proper sidebar card, updates as you change format */}
          {previewWide && (
            <div style={{ position: "fixed", top: 72, right: 24, width: 440, maxHeight: "84vh", overflowY: "auto", zIndex: 500, background: "linear-gradient(180deg, rgba(19,21,29,0.98), rgba(13,15,20,0.98))", border: "1px solid var(--cb-border2)", boxShadow: "0 12px 44px rgba(0,0,0,0.55), inset 0 1px 0 rgba(124,92,255,0.18)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px 10px", borderBottom: "1px solid var(--cb-border)" }}>
                <div>
                  <div style={{ fontFamily: "var(--cb-font-display)", fontSize: 13, fontWeight: 700, letterSpacing: "0.2em", color: "var(--cb-purple2)", textTransform: "uppercase" }}>Live Preview</div>
                  <div style={{ fontFamily: "var(--cb-font-mono)", fontSize: 10, color: "var(--cb-muted)", marginTop: 3 }}>{tournamentSize} teams · {tournamentMode === "double" ? "Double Elimination" : "Single Elimination"}</div>
                </div>
                <span className="cb-chip" style={{ borderColor: "rgba(124,92,255,0.4)", color: "var(--cb-purple2)" }}>{globalFormat === 4 ? "CASH-OUT" : "FINAL RND"}</span>
              </div>
              <div style={{ padding: "16px 18px 18px" }}>
                <BracketPreview size={tournamentSize} mode={tournamentMode} opts={engineOpts} config={resolveConfig(tournamentSize, tournamentMode, globalFormat, formatConfig, engineOpts)} />
              </div>
            </div>
          )}

          {/* STEP 01 — Mode */}
          <div className="setup-step">
            <div className="step-head"><span className="step-num">01</span><span className="step-title">Mode</span></div>
            <div className="mode-selector">
              <button className={`mode-btn${tournamentMode === "single" ? " active" : ""}`} onClick={() => setTournamentMode("single")}>
                <span className="mode-btn-title">Single Elimination</span>
                <span className="mode-btn-desc">Lose once — you're out. Fast format.</span>
              </button>
              <button
                className={`mode-btn${tournamentMode === "double" ? " active de" : ""}`}
                disabled={tournamentSize < 8}
                style={tournamentSize < 8 ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
                onClick={() => tournamentSize >= 8 && setTournamentMode("double")}
              >
                <span className="mode-btn-title">Double Elimination</span>
                <span className="mode-btn-desc">{tournamentSize < 8 ? "Needs 8+ teams" : "3rd/4th drop to Losers Bracket · 2 chances"}</span>
              </button>
            </div>
          </div>

          {/* STEP 02 — Size */}
          <div className="setup-step">
            <div className="step-head"><span className="step-num">02</span><span className="step-title">Size</span><span className="step-hint">teams in the bracket</span></div>
            <div className="size-selector">
              {([2, 4, 8, 16, 32] as const).map((s) => (
                <button key={s} className={`size-btn${tournamentSize === s ? " active" : ""}`} onClick={() => handleSizeChange(s)}>{s}</button>
              ))}
            </div>
          </div>

          {/* STEP 03 — Match format (advanced: per-phase overrides + finals structure) */}
          <div className="setup-step">
            <div className="step-head"><span className="step-num">03</span><span className="step-title">Match Format</span></div>
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
            </div>
            <details className="adv">
              <summary>Advanced — per-phase overrides · finals: {finalsBracket ? "head-to-head semis" : "direct to grand final"}</summary>
              <div className="adv-inner">
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

                {/* Finals structure */}
                <div className="format-global-row" style={{ paddingTop: 10, borderTop: "1px solid var(--cb-border)" }}>
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
                <div style={{ fontSize: 11, color: "var(--cb-muted)", letterSpacing: "0.02em", padding: "0 4px", lineHeight: 1.5 }}>
                  {finalsBracket
                    ? "Cash-Out Final (4 teams) splits into two 1v1 games: 1st vs 4th and 2nd vs 3rd. Each winner advances to the Grand Final."
                    : "Cash-Out Final (4 teams) sends its top 2 straight to the Grand Final."}
                </div>
                <div className="format-locked-row">
                  <span className="format-label" style={{ color: "var(--cb-muted)" }}>GRAND FINAL</span>
                  <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 10.5, color: "var(--cb-muted)", letterSpacing: "0.05em" }}>2-TEAM (locked)</span>
                </div>
              </div>
            </details>
          </div>

          {/* STEP 04 — Teams & seeds (advanced: CSV import) */}
          <div className="setup-step">
            <div className="step-head">
              <span className="step-num">04</span><span className="step-title">Teams &amp; Seeds</span>
              <span className="step-hint">drag to reorder · Seed 1 = strongest</span>
            </div>
            <div className="seeds-list">
              {seeds.map((entry, i) => (
                <div key={i} className="seed-row" draggable onDragStart={() => handleDragStart(i)} onDragOver={(e) => handleDragOver(e, i)} onDrop={handleDrop}>
                  <span className="seed-drag-handle"><GripVertical size={14} /></span>
                  <span className="seed-number">#{entry.seed}</span>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                    <input className="team-input" type="text" value={entry.name} placeholder={`Team ${i + 1}`} onChange={(e) => handleNameChange(i, e.target.value)} maxLength={24} />
                    <input
                      className="team-input players-input"
                      type="text"
                      value={rosterDrafts[`p${i}`] ?? (entry.players ?? []).join(", ")}
                      placeholder="Players: Player1, Player2, Player3..."
                      onChange={(e) => {
                        const raw = e.target.value;
                        setRosterDrafts((prev) => ({ ...prev, [`p${i}`]: raw }));
                        const players = raw.split(",").map((p) => p.trim()).filter(Boolean);
                        setSeeds((prev) => prev.map((s, si) => si === i ? { ...s, players } : s));
                      }}
                      onBlur={() => clearRosterDraft(`p${i}`)}
                      style={{ opacity: 0.75 }}
                    />
                    <input
                      className="team-input players-input"
                      type="text"
                      value={rosterDrafts[`d${i}`] ?? (entry.discords ?? []).join(", ")}
                      placeholder="Discords: user1, user2... (chat access)"
                      onChange={(e) => {
                        const raw = e.target.value;
                        setRosterDrafts((prev) => ({ ...prev, [`d${i}`]: raw }));
                        const discords = raw.split(",").map((p) => p.trim()).filter(Boolean);
                        setSeeds((prev) => prev.map((s, si) => si === i ? { ...s, discords } : s));
                      }}
                      onBlur={() => clearRosterDraft(`d${i}`)}
                      style={{ opacity: 0.6 }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <details className="adv" open={showCsvPanel} onToggle={(e) => setShowCsvPanel((e.target as HTMLDetailsElement).open)}>
              <summary>Import teams — Notion / CSV / Google Sheets</summary>
              <div className="adv-inner">
                <div className="csv-row">
                  <input
                    className="team-input"
                    type="text"
                    value={notionTag}
                    onChange={(e) => setNotionTag(e.target.value)}
                    placeholder="Tournament tag (e.g. CBL03) — empty = all"
                    style={{ flex: 1 }}
                  />
                  <button className="cb-btn accent" onClick={handleNotionImport} disabled={notionLoading}>
                    {notionLoading ? "Importing..." : "Import from Notion"}
                  </button>
                </div>
                <div className="csv-row">
                  <input
                    className="team-input"
                    type="text"
                    value={csvUrl}
                    onChange={(e) => setCsvUrl(e.target.value)}
                    placeholder="Published Google Sheet CSV URL..."
                    style={{ flex: 1 }}
                  />
                  <button className="cb-btn info" onClick={handleCsvFetch} disabled={csvLoading}>
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
                              style={{ accentColor: "var(--cb-purple)" }}
                            />
                            {h || `Col ${i}`}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="csv-mapping-row" style={{ alignItems: "flex-start" }}>
                      <span className="csv-mapping-label" style={{ paddingTop: 4 }}>Player Discords</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {csvRows[0].map((h, i) => (
                          <label key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--cb-muted)", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={csvDiscordCols.includes(i)}
                              onChange={e => {
                                setCsvDiscordCols(prev => e.target.checked ? [...prev, i] : prev.filter(x => x !== i));
                              }}
                              style={{ accentColor: "var(--cb-cyan)" }}
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
            </details>
          </div>

          {/* STEP 05 — Details: name is shown to spectators, your name to co-editors */}
          <div className="setup-step">
            <div className="step-head"><span className="step-num">05</span><span className="step-title">Details</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 380 }}>
              <div style={{ fontSize: 11.5, color: "var(--cb-muted)" }}>Tournament name (shown to spectators)</div>
              <input className="team-input" type="text" value={tournamentName} onChange={(e) => { setTournamentName(e.target.value); sessionStorage.setItem("cb_session_name", e.target.value); }} placeholder="e.g. CODE Big League..." />
              <div style={{ fontSize: 11.5, color: "var(--cb-muted)", marginTop: 4 }}>Your name (shown to co-editors)</div>
              <input className="team-input" type="text" value={editorName} onChange={(e) => { setEditorName(e.target.value); localStorage.setItem("cb_editor", e.target.value); }} placeholder="Your name..." />
            </div>
          </div>

          {/* Sticky footer: summary + primary CTA */}
          <div className="setup-footer">
            <span className="setup-footer-meta">
              {tournamentSize} TEAMS · {tournamentMode === "double" ? "DOUBLE ELIM" : "SINGLE ELIM"} · {globalFormat === 4 ? "CASH-OUT" : "FINAL ROUND"} · <b>READY</b>
            </span>
            <button className="cb-btn generate" style={{ width: "auto", margin: 0, padding: "12px 34px" }} onClick={handleGenerate}>
              Generate Bracket →
            </button>
            <button className="cb-btn info" onClick={() => { setShowOngoing(true); fetchOngoing(); }}>
              Connect to Session
            </button>
            {saves.length > 0 && (
              <button className="cb-btn warn" onClick={() => setShowSavePanel(true)}>
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
              const color = c.isDrop ? (c.active ? "#ff8a3d" : "#2b1c10") : (c.active ? "#28d17c" : "#20242f");
              const strokeWidth = c.active ? 2 : 1;
              const dashArray = c.isDrop ? "4,5" : undefined;
              const glow = c.active ? `drop-shadow(0 0 3px ${c.isDrop ? "rgba(255,138,61,0.4)" : "rgba(40,209,124,0.4)"})` : undefined;
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
                  style={{ filter: glow }}
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
              background: "var(--cb-bg)", borderLeft: "1px solid var(--cb-border2)",
              display: "flex", flexDirection: "column",
              boxShadow: "-4px 0 24px rgba(0,0,0,0.7)",
              transform: "translateX(0)",
              transition: "transform 0.2s cubic-bezier(0.2,0.8,0.2,1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--cb-border)" }}>
              <span style={{ fontFamily: "var(--cb-font-display)", fontSize: 13, fontWeight: 700, letterSpacing: "0.18em", color: "var(--cb-silver)", textTransform: "uppercase" }}>Select Map</span>
              <button className="cb-btn ghost" style={{ padding: "4px 8px" }} onClick={() => setMapPickerPod(null)}><X size={14} /></button>
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
                      background: isSelected ? "rgba(124,92,255,0.12)" : "transparent",
                      borderLeft: isSelected ? "2px solid var(--cb-purple)" : "2px solid transparent",
                      display: "flex", alignItems: "center", gap: 10,
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)"; }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <span style={{ fontFamily: "var(--cb-font-display)", fontSize: 13, fontWeight: isSelected ? 700 : 500, color: isSelected ? "var(--cb-purple2)" : "var(--cb-silver)", letterSpacing: "0.05em" }}>
                      {mapName}
                    </span>
                    {isSelected && <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 9, letterSpacing: "0.15em", color: "var(--cb-purple)", marginLeft: "auto" }}>SELECTED</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Admin Token Dialog */}
      {showTokenDialog && (
        <div className="cb-modal-backdrop" style={{ zIndex: 10000 }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowTokenDialog(false); }}>
          <div className="cb-modal" style={{ padding: "24px 28px", minWidth: 340, maxWidth: 420, gap: 12 }}>
            <div className="cb-modal-title">Sign in</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["login", "register", "master"] as const).map((mode) => (
                <button key={mode} className={`cb-btn${authMode === mode ? " accent" : ""}`} style={{ flex: 1, fontSize: 11, padding: "5px 4px" }}
                  onClick={() => { setAuthMode(mode); setTokenError(""); }}>
                  {mode === "login" ? "Log in" : mode === "register" ? "Register" : "Admin"}
                </button>
              ))}
            </div>
            {authMode === "login" && (
              <>
                <input className="team-input" autoFocus placeholder="Account / org name" value={fLoginName} onChange={(e) => setFLoginName(e.target.value)} />
                <input className="team-input" type="password" placeholder="Password" value={fLoginPass} onChange={(e) => setFLoginPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleTokenSubmit(); }} />
              </>
            )}
            {authMode === "register" && (
              <>
                <div style={{ fontSize: 11.5, color: "var(--cb-muted)", lineHeight: 1.5 }}>Have an invite code? Create your organizer account.</div>
                <input className="team-input" placeholder="Invite code (INV-…)" value={fRegInvite} onChange={(e) => setFRegInvite(e.target.value.toUpperCase())} />
                <input className="team-input" placeholder="Account / org name" value={fRegName} onChange={(e) => setFRegName(e.target.value)} />
                <input className="team-input" type="password" placeholder="Choose a password (6+ chars)" value={fRegPass} onChange={(e) => setFRegPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleTokenSubmit(); }} />
              </>
            )}
            {authMode === "master" && (
              <>
                <div style={{ fontSize: 11.5, color: "var(--cb-muted)", lineHeight: 1.5 }}>Super-admin master password.</div>
                <input className="team-input" type="password" autoFocus placeholder="Master password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleTokenSubmit(); if (e.key === "Escape") setShowTokenDialog(false); }} />
              </>
            )}
            {tokenError && <div style={{ fontSize: 11.5, color: "var(--cb-red)" }}>{tokenError}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button className="cb-btn ghost" onClick={() => setShowTokenDialog(false)}>Cancel</button>
              <button className="cb-btn primary" disabled={authBusy} onClick={handleTokenSubmit}>{authBusy ? "…" : "Continue"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Invites modal (super-admin) */}
      {showInvites && (
        <div className="cb-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowInvites(false); }}>
          <div className="cb-modal" style={{ width: 520, maxWidth: "92vw", maxHeight: "72vh" }}>
            <div className="cb-modal-head">
              <span className="cb-modal-title">Invites</span>
              <button className="cb-btn ghost" style={{ padding: "4px 8px" }} onClick={() => setShowInvites(false)}><X size={14} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--cb-border)" }}>
              <input className="team-input" placeholder="Note (e.g. org name)" value={newInviteNote} onChange={(e) => setNewInviteNote(e.target.value)} style={{ flex: 1 }} onKeyDown={(e) => { if (e.key === "Enter") mintInvite(); }} />
              <button className="cb-btn accent" onClick={mintInvite}>Generate invite</button>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              {invitesList.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--cb-muted)", fontSize: 13 }}>{invitesLoading ? "Loading..." : "No invites yet"}</div>}
              {invitesList.map((iv) => (
                <div key={iv.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", borderBottom: "1px solid var(--cb-border)" }}>
                  <span title="Click to copy" style={{ fontFamily: "var(--cb-font-mono)", fontSize: 12.5, color: iv.usedBy ? "var(--cb-muted)" : "var(--cb-purple2)", letterSpacing: "0.1em", cursor: "pointer" }} onClick={() => { navigator.clipboard.writeText(iv.code); toast("Code copied"); }}>{iv.code}</span>
                  {iv.note && <span style={{ fontSize: 11, color: "var(--cb-muted)" }}>{iv.note}</span>}
                  <span style={{ marginLeft: "auto", fontFamily: "var(--cb-font-mono)", fontSize: 10.5, color: iv.usedBy ? "var(--cb-gold)" : "var(--cb-green)" }}>{iv.usedBy ? `used by ${iv.usedBy}` : "unused"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Ongoing Tournaments modal */}
      {showOngoing && (
        <div className="cb-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setShowOngoing(false); }}>
          <div className="cb-modal" style={{ width: 540, maxWidth: "92vw", maxHeight: "72vh" }}>
            <div className="cb-modal-head">
              <span className="cb-modal-title">Ongoing Tournaments</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="cb-btn" style={{ padding: "4px 10px", fontSize: 11 }} onClick={fetchOngoing} disabled={ongoingLoading}>{ongoingLoading ? "..." : "Refresh"}</button>
                <button className="cb-btn ghost" style={{ padding: "4px 8px" }} onClick={() => setShowOngoing(false)}><X size={14} /></button>
              </div>
            </div>
            <div style={{ overflow: "auto", flex: 1 }}>
              {ongoingSessions.length === 0 && (
                <div style={{ padding: 24, textAlign: "center", color: "var(--cb-muted)", fontSize: 13 }}>{ongoingLoading ? "Loading..." : "No active tournaments"}</div>
              )}
              {ongoingSessions.map((s) => (
                <div key={s.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--cb-border)", background: s.code === sessionCode ? "rgba(124,92,255,0.10)" : undefined }}>
                  <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => joinByCode(s.code)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "var(--cb-font-display)", fontSize: 14, fontWeight: 700, color: "var(--cb-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name || "Untitled"}</span>
                      <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 11, color: "var(--cb-cyan)", letterSpacing: "0.1em" }}>{s.code}</span>
                      {s.code === sessionCode && <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 9, color: "var(--cb-green)", border: "1px solid rgba(40,209,124,0.5)", padding: "1px 5px", letterSpacing: "0.1em" }}>CURRENT</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--cb-muted)", marginTop: 2 }}>
                      {[s.size ? `${s.size} teams` : null, s.mode ? (s.mode === "double" ? "Double Elim" : "Single Elim") : null, s.host || null, s.updatedAt ? timeAgo(s.updatedAt) : null].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <button className="cb-btn info" style={{ padding: "3px 10px", fontSize: 11 }} onClick={() => joinByCode(s.code)}>Open</button>
                  <button className="cb-btn danger" style={{ padding: "3px 9px", fontSize: 13, lineHeight: 1 }} title="Delete tournament" onClick={() => requestDeleteSession(s.code)}>×</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Live indicator */}
      {isLive && screen === "bracket" && !screenshotMode && (
        <div className="cb-chip live" style={{ position: "fixed", top: 10, right: 16, zIndex: 9999, background: "rgba(8,9,12,0.92)", padding: "4px 12px" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--cb-red)", display: "inline-block", animation: "livePulse 1.6s ease-in-out infinite" }} />
          LIVE
        </div>
      )}

      {/* Action Bar */}
      {screen === "bracket" && !screenshotMode && (
        <div className="action-bar">
          <button className="cb-btn" onClick={handleReset}>Reset Results</button>
          <button className="cb-btn" onClick={handleNewTournament}>Home</button>
          {adminToken && <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 10.5, letterSpacing: "0.08em", color: "var(--cb-purple2)" }}>{authKind === "master" ? "SUPER-ADMIN" : (authName || "Signed in")}</span>}
          <button className={`cb-btn${compactMode ? " accent" : ""}`} onClick={handleCompact}>{compactMode ? "Normal" : "Compact"}</button>
          <button className="cb-btn success" onClick={handleExportPng}>Export PNG</button>
          <button className="cb-btn warn" onClick={() => setShowSavePanel(true)}>Saves</button>
          {adminToken && !tournamentStarted && sessionCode && (
            <button className="cb-btn" style={{ borderColor: "var(--cb-green)", color: "var(--cb-green)", fontWeight: 700 }} onClick={() => setShowStartConfirm(true)}>Start Tournament</button>
          )}
          {tournamentStarted && (
            <span className="cb-chip" style={{ fontFamily: "var(--cb-font-mono)", fontSize: 10, letterSpacing: "0.1em", color: "var(--cb-green)", border: "1px solid rgba(40,209,124,0.5)", padding: "3px 8px" }}>STARTED</span>
          )}
          {adminToken && <button className="cb-btn" style={{ borderColor: "var(--cb-purple)", color: "var(--cb-purple2)" }} onClick={openTeamEditor}>Teams</button>}
          {adminToken && authKind !== "cohost" && <button className="cb-btn" style={{ borderColor: "var(--cb-gold)", color: "var(--cb-gold)" }} onClick={() => setShowArchiveConfirm(true)}>Archive</button>}
          {/* Session chip */}
          {sessionCode && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(124,92,255,0.08)", border: "1px solid rgba(124,92,255,0.5)", padding: "4px 10px", fontSize: 11, letterSpacing: "0.08em" }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", display: "inline-block", flexShrink: 0,
                background: syncStatus === "synced" ? "var(--cb-green)" : syncStatus === "syncing" ? "var(--cb-gold)" : syncStatus === "conflict" ? "var(--cb-red)" : "var(--cb-border2)",
                boxShadow: syncStatus === "syncing" ? "0 0 6px var(--cb-gold)" : undefined,
              }} />
              <span style={{ fontFamily: "var(--cb-font-mono)", color: "var(--cb-purple2)", fontWeight: 600 }}>{sessionCode}</span>
              {lastEditor && <span style={{ color: "var(--cb-muted)" }}>by {lastEditor}</span>}
              <button className="cb-btn success" style={{ padding: "2px 7px", fontSize: 10 }} onClick={() => { navigator.clipboard.writeText(`https://rauder999.github.io/codebreakers-bracket/live.html?session=${sessionCode}`); toast.success("Live link copied!"); }}>Live Link</button>
              {authKind !== "cohost" && <button className="cb-btn accent" style={{ padding: "2px 7px", fontSize: 10 }} onClick={() => sessionCode && shareSession(sessionCode)}>Share</button>}
              <button className="cb-btn ghost" style={{ padding: "2px 7px", fontSize: 10 }} onClick={handleLeaveSession}>Leave</button>
              {authKind !== "cohost" && <button className="cb-btn danger" style={{ padding: "2px 7px", fontSize: 10 }} title="Delete this tournament session (archives and player stats are kept)" onClick={() => sessionCode && requestDeleteSession(sessionCode)}>Delete</button>}
            </div>
          )}
          <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 9.5, color: "var(--cb-muted)", opacity: 0.6, letterSpacing: "0.06em", marginLeft: 4 }}>CTRL+Z UNDO · CTRL+Y REDO</span>
        </div>
      )}

      {/* In-tournament roster editor */}
      {showTeamEditor && (
        <div className="cb-modal-backdrop" style={{ zIndex: 1100 }} onClick={() => setShowTeamEditor(false)}>
          <div className="cb-modal" style={{ padding: 24, minWidth: 480, maxWidth: 620, maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
            <div className="cb-modal-title" style={{ color: "var(--cb-purple2)", marginBottom: 6 }}>Edit Teams</div>
            <div style={{ fontSize: 12, color: "var(--cb-muted)", lineHeight: 1.5, marginBottom: 14 }}>
              Substitute players, fix Discord usernames or rename a team mid-tournament. Applies to the bracket, the live page and the Discord bot immediately — results and progress are untouched.
            </div>
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}>
              {teamDrafts.map((d, i) => (seeds[i]?.name || d.name ? (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, borderLeft: "3px solid var(--cb-border2)", paddingLeft: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 10, color: "var(--cb-muted)", minWidth: 24 }}>#{seeds[i]?.seed ?? i + 1}</span>
                    <input className="team-input" type="text" value={d.name} maxLength={24} placeholder="Team name"
                      onChange={(e) => setTeamDrafts((prev) => prev.map((x, xi) => xi === i ? { ...x, name: e.target.value } : x))} />
                  </div>
                  <input className="team-input players-input" type="text" value={d.players} placeholder="Players: Player1, Player2..."
                    style={{ marginLeft: 32, opacity: 0.85 }}
                    onChange={(e) => setTeamDrafts((prev) => prev.map((x, xi) => xi === i ? { ...x, players: e.target.value } : x))} />
                  <input className="team-input players-input" type="text" value={d.discords} placeholder="Discords: user1, user2..."
                    style={{ marginLeft: 32, opacity: 0.7 }}
                    onChange={(e) => setTeamDrafts((prev) => prev.map((x, xi) => xi === i ? { ...x, discords: e.target.value } : x))} />
                </div>
              ) : null))}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="cb-btn ghost" onClick={() => setShowTeamEditor(false)}>Cancel</button>
              <button className="cb-btn" style={{ borderColor: "var(--cb-purple)", color: "var(--cb-purple2)", fontWeight: 700 }} onClick={handleTeamEditorSave}>Save &amp; Sync</button>
            </div>
          </div>
        </div>
      )}

      {/* Start tournament confirm */}
      {showStartConfirm && (
        <div className="cb-modal-backdrop" style={{ zIndex: 1100 }} onClick={() => setShowStartConfirm(false)}>
          <div className="cb-modal" style={{ padding: 24, minWidth: 380, maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="cb-modal-title" style={{ color: "var(--cb-green)", marginBottom: 12 }}>Start Tournament</div>
            <div style={{ fontSize: 13, color: "var(--cb-text)", lineHeight: 1.6, marginBottom: 16 }}>
              The Discord bot will immediately ping every round-1 team and open their private match threads (map bans, lobby setup, result submission). Until you start, the bot stays silent.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="cb-btn ghost" onClick={() => setShowStartConfirm(false)}>Cancel</button>
              <button className="cb-btn" style={{ borderColor: "var(--cb-green)", color: "var(--cb-green)" }} onClick={handleStartTournament}>Start — ping the teams</button>
            </div>
          </div>
        </div>
      )}

      {/* Archive confirm */}
      {showArchiveConfirm && (
        <div className="cb-modal-backdrop" style={{ zIndex: 1100 }} onClick={() => !archiveBusy && setShowArchiveConfirm(false)}>
          <div className="cb-modal" style={{ padding: 24, minWidth: 380, maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="cb-modal-title" style={{ color: "var(--cb-gold)", marginBottom: 12 }}>Archive Tournament</div>
            <div style={{ fontSize: 13, color: "var(--cb-text)", lineHeight: 1.6, marginBottom: 8 }}>
              <b>{tournamentName || "Untitled Tournament"}</b> · {tournamentMode === "double" ? "DE" : "SE"} · {tournamentSize} teams
            </div>
            {archiveChampion ? (
              <div style={{ fontSize: 13, color: "var(--cb-gold)", marginBottom: 12 }}>Champion: <b>{archiveChampion}</b></div>
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--cb-orange)", marginBottom: 12 }}>No champion yet — the Grand Final is not decided. You can still archive, but the bracket will be saved as-is.</div>
            )}
            <div style={{ fontSize: 12.5, color: "var(--cb-muted)", lineHeight: 1.6, marginBottom: 18 }}>
              A frozen snapshot will be saved to the public archive gallery. It can never be edited — only viewed (or deleted by you).
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="cb-btn ghost" disabled={archiveBusy} onClick={() => setShowArchiveConfirm(false)}>Cancel</button>
              <button className="cb-btn" style={{ borderColor: "var(--cb-gold)", color: "var(--cb-gold)" }} disabled={archiveBusy} onClick={handleArchiveTournament}>{archiveBusy ? "Archiving..." : "Freeze & Archive"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Match History Panel */}
      {showHistory && (
        <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 340, background: "var(--cb-bg)", borderLeft: "1px solid var(--cb-border2)", zIndex: 900, display: "flex", flexDirection: "column", boxShadow: "-4px 0 24px rgba(0,0,0,0.6)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid var(--cb-border)" }}>
            <span style={{ fontFamily: "var(--cb-font-display)", fontSize: 14, fontWeight: 700, letterSpacing: "0.15em", color: "var(--cb-cyan)", textTransform: "uppercase" }}>Match History</span>
            <button className="cb-btn ghost" style={{ padding: "4px 8px" }} onClick={() => setShowHistory(false)}><X size={14} /></button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
            {(() => {
              const completed = pods.filter((pod) => pod.teams.some((t) => t.name && t.placement !== 0) && pod.teams.filter((t) => t.name).length >= 2);
              if (completed.length === 0) return <div style={{ color: "var(--cb-muted)", fontSize: 13, textAlign: "center", padding: 32 }}>No results yet</div>;
              return completed.map((pod) => {
                const sorted = [...pod.teams].filter((t) => t.name && t.placement !== 0).sort((a, b) => a.placement - b.placement);
                const isComplete = pod.teams.filter((t) => t.name).every((t) => t.placement !== 0);
                return (
                  <div key={pod.id} style={{ marginBottom: 12, background: "var(--cb-panel)", border: "1px solid var(--cb-border)", padding: "10px 12px" }}>
                    <div style={{ fontFamily: "var(--cb-font-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.14em", color: "var(--cb-muted)", marginBottom: 6, textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
                      <span>{pod.label}</span>
                      {!isComplete && <span style={{ color: "var(--cb-gold)" }}>partial</span>}
                    </div>
                    {sorted.map((t) => (
                      <div key={t.name + t.placement} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--cb-border)" }}>
                        <span style={{ fontFamily: "var(--cb-font-mono)", fontSize: 11, minWidth: 24, color: PLACEMENT_COLORS[t.placement] || "var(--cb-muted)" }}>
                          #{t.placement}
                        </span>
                        <span style={{ fontFamily: "var(--cb-font-display)", fontSize: 13, fontWeight: t.placement === 1 ? 700 : 500, color: t.placement === 1 ? "var(--cb-gold)" : "var(--cb-muted)" }}>{t.name}</span>
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
        <div className="cb-modal-backdrop" style={{ zIndex: 1000 }} onClick={() => setShowSavePanel(false)}>
          <div className="cb-modal" style={{ padding: 24, minWidth: 420, maxWidth: 560, maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span className="cb-modal-title" style={{ color: "var(--cb-gold)" }}>Tournaments</span>
              <button className="cb-btn ghost" style={{ padding: "4px 8px" }} onClick={() => setShowSavePanel(false)}><X size={14} /></button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input className="team-input" value={saveNameInput} onChange={(e) => setSaveNameInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSaveTournament()} placeholder="Save name (optional)..." style={{ flex: 1 }} />
              <button className="cb-btn success" onClick={handleSaveTournament}>Save</button>
            </div>
            {saves.length === 0 ? (
              <div style={{ color: "var(--cb-muted)", fontSize: 13, textAlign: "center", padding: 24 }}>No saved tournaments yet</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {saves.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--cb-panel2)", border: "1px solid var(--cb-border)", padding: "8px 12px" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--cb-font-display)", fontSize: 13, fontWeight: 700, color: "var(--cb-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: "var(--cb-muted)", marginTop: 2 }}>
                        {s.tournamentMode === "double" ? "DE" : "SE"} · {s.tournamentSize} teams · {s.screen === "bracket" ? "In progress" : "Setup"} · {new Date(s.savedAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <button className="cb-btn accent" style={{ padding: "6px 12px", fontSize: 11 }} onClick={() => handleLoadTournament(s)}>Load</button>
                    <button className="cb-btn danger" style={{ padding: "6px 12px", fontSize: 11 }} onClick={() => handleDeleteSave(s.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Connector legend */}
      {screen === "bracket" && !screenshotMode && (
        <div style={{ position: "fixed", bottom: 16, left: 16, zIndex: 200, background: "rgba(8,9,12,0.88)", border: "1px solid var(--cb-border)", padding: "8px 12px", fontFamily: "var(--cb-font-mono)", fontSize: 9.5, color: "var(--cb-muted)", letterSpacing: "0.08em", textTransform: "uppercase", display: "flex", flexDirection: "column", gap: 5, backdropFilter: "blur(4px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="28" height="4" viewBox="0 0 28 4"><line x1="0" y1="2" x2="28" y2="2" stroke="#28d17c" strokeWidth="2"/></svg>
            <span>Advances</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="28" height="4" viewBox="0 0 28 4"><line x1="0" y1="2" x2="28" y2="2" stroke="#ff8a3d" strokeWidth="2" strokeDasharray="4 3"/></svg>
            <span>Drops to LB</span>
          </div>
        </div>
      )}
      {screen === "bracket" && screenshotMode && (
        <div className="screenshot-exit-bar">
          <button className="cb-btn primary" onClick={handleScreenshot}>Exit Screenshot</button>
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
          ><Video size={13} /></button>
        )}
        {pod.liveNow && screenshotMode && <span className="stream-badge-static">● LIVE</span>}
        {pod.onStream && !pod.liveNow && screenshotMode && <span className="stream-badge-planned"><Video size={12} /></span>}
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

        const placementLabel = team.placement !== 0 ? PLACEMENT_LABELS[team.placement as Placement] : "";

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
            <span className="team-emoji">{isChampion ? <Crown size={13} strokeWidth={2.2} fill="currentColor" /> : null}</span>
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
