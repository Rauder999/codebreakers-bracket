// ============================================================================
// Codebreakers Bracket Engine - generative, per-phase format (2 or 4 teams)
// ============================================================================
// Key invariant: every pod advances exactly HALF its teams.
//   4-team pod -> top 2 advance, bottom 2 drop/eliminated
//   2-team pod -> top 1 advances, bottom 1 drops/eliminated
// So a phase's OUTPUT count = inputCount / 2, regardless of podSize.
// This keeps bracket topology identical whether a stage is 2-team or 4-team.
// ============================================================================

export type Placement = 0 | 1 | 2 | 3 | 4;
export type TournamentMode = "single" | "double";
export type PodSize = 2 | 4;
export type Bracket = "wb" | "lb" | "gf";
export type Size = 2 | 4 | 8 | 16 | 32;

export interface TeamSlot {
  name: string;
  placement: Placement;
  seed: number;
  sourceGroup?: string;
  path?: "wb" | "lb";
  players?: string[];
}

export interface Pod {
  id: string;
  label: string;
  phase: string;
  bracket: Bracket;
  teams: TeamSlot[];
  hasNoLBDrop?: boolean;
  map?: string; // map name for this match
  onStream?: boolean; // planned to be streamed (multiple allowed)
  liveNow?: boolean;  // currently being broadcast (only one at a time)
}

export interface SeedEntry {
  name: string;
  seed: number;
  players: string[];
  discords?: string[]; // Discord usernames of the roster (chat access on live.html)
}

// A phase is a logical round. Pods are generated from it based on podSize.
export interface PhaseSpec {
  id: string;
  label: string;
  bracket: Bracket;
  inputCount: number;     // teams entering this phase
  advanceTo?: string;     // phase id advancers go to
  dropTo?: string;        // phase id droppers go to (DE WB only)
  hasNoLBDrop?: boolean;  // bottom half eliminated instead of dropped
  isGroups?: boolean;     // first round, seeded from seed list
  forcePodSize?: PodSize; // structural override that beats any format config
}

// PodSize override map: phaseId -> 2 | 4. Missing = default (4, except gf=2).
export type FormatConfig = Record<string, PodSize>;

// Extra structural options.
export interface EngineOptions {
  // When true, the 4-team final (SE "final" / DE "cashout") no longer sends its
  // top 2 straight to the Grand Final. Instead ALL 4 advance, paired head-to-head
  // by placement (1st vs 4th, 2nd vs 3rd) into two 2-team semis, whose winners
  // meet in the Grand Final.
  finalsBracket?: boolean;
}

// ─── Phase graphs ────────────────────────────────────────────────────────────

// Insert the head-to-head finals-bracket round before the GF, if enabled.
// The 4-team final phase id is "final" (SE) or "cashout" (DE).
function applyFinalsBracket(graph: PhaseSpec[], opts?: EngineOptions): PhaseSpec[] {
  if (!opts?.finalsBracket) return graph;
  const finalId = graph.find((p) => p.id === "cashout") ? "cashout" : "final";
  const out: PhaseSpec[] = [];
  for (const p of graph) {
    if (p.id === finalId) {
      // final now feeds the two head-to-head semis instead of gf directly.
      // Must be a single 4-team match (needs four placements for 1v4/2v3),
      // so it overrides any 2-team format config.
      out.push({ ...p, advanceTo: "fbracket", forcePodSize: 4 });
    } else if (p.id === "gf") {
      // two 2-team semis (rendered as one phase with 2 pods), then gf
      out.push({ id: "fbracket", label: "FINALS", bracket: "gf", inputCount: 4, advanceTo: "gf" });
      out.push(p);
    } else {
      out.push(p);
    }
  }
  return out;
}

export function getPhaseGraph(size: Size, mode: TournamentMode, opts?: EngineOptions): PhaseSpec[] {
  // Mini-brackets (2/4 teams) have no room for a finals-bracket insert.
  if (size < 8) return getBasePhaseGraph(size, mode);
  return applyFinalsBracket(getBasePhaseGraph(size, mode), opts);
}

function getBasePhaseGraph(size: Size, mode: TournamentMode): PhaseSpec[] {
  // 2 and 4 teams are always effectively single-elimination, whatever the mode.
  if (size === 4) return [
    { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 4, advanceTo: "gf", isGroups: true },
    { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
  ];
  if (size === 2) return [
    // The only phase doubles as the seeded round, hence isGroups.
    { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2, isGroups: true },
  ];
  if (mode === "single") {
    if (size === 8) return [
      { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 8, advanceTo: "final", isGroups: true },
      { id: "final", label: "CASH-OUT FINAL", bracket: "wb", inputCount: 4, advanceTo: "gf" },
      { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
    ];
    if (size === 16) return [
      { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 16, advanceTo: "semis", isGroups: true },
      { id: "semis", label: "SEMIFINALS", bracket: "wb", inputCount: 8, advanceTo: "final" },
      { id: "final", label: "CASH-OUT FINAL", bracket: "wb", inputCount: 4, advanceTo: "gf" },
      { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
    ];
    return [
      { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 32, advanceTo: "quarters", isGroups: true },
      { id: "quarters", label: "QUARTERFINALS", bracket: "wb", inputCount: 16, advanceTo: "semis" },
      { id: "semis", label: "SEMIFINALS", bracket: "wb", inputCount: 8, advanceTo: "final" },
      { id: "final", label: "CASH-OUT FINAL", bracket: "wb", inputCount: 4, advanceTo: "gf" },
      { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
    ];
  }

  // Double elimination
  if (size === 8) return [
    { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 8, advanceTo: "wb-final", dropTo: "lb-r1", isGroups: true },
    { id: "wb-final", label: "WB FINAL", bracket: "wb", inputCount: 4, advanceTo: "cashout", dropTo: "lb-final" },
    { id: "lb-r1", label: "LB ROUND 1", bracket: "lb", inputCount: 4, advanceTo: "lb-final" },
    { id: "lb-final", label: "LB FINAL", bracket: "lb", inputCount: 4, advanceTo: "cashout" },
    { id: "cashout", label: "CASH-OUT FINAL", bracket: "gf", inputCount: 4, advanceTo: "gf", hasNoLBDrop: true },
    { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
  ];
  if (size === 16) return [
    { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 16, advanceTo: "wb-semis", dropTo: "lb-r1", isGroups: true },
    { id: "wb-semis", label: "WB SEMIFINALS", bracket: "wb", inputCount: 8, advanceTo: "wb-final", dropTo: "lb-r2" },
    { id: "wb-final", label: "WB FINAL", bracket: "wb", inputCount: 4, advanceTo: "cashout", dropTo: "lb-final" },
    { id: "lb-r1", label: "LB ROUND 1", bracket: "lb", inputCount: 8, advanceTo: "lb-r2" },
    { id: "lb-r2", label: "LB ROUND 2", bracket: "lb", inputCount: 8, advanceTo: "lb-semi" },
    { id: "lb-semi", label: "LB SEMIFINAL", bracket: "lb", inputCount: 4, advanceTo: "lb-final" },
    { id: "lb-final", label: "LB FINAL", bracket: "lb", inputCount: 4, advanceTo: "cashout" },
    { id: "cashout", label: "CASH-OUT FINAL", bracket: "gf", inputCount: 4, advanceTo: "gf", hasNoLBDrop: true },
    { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
  ];
  return [
    { id: "groups", label: "GROUP STAGE", bracket: "wb", inputCount: 32, advanceTo: "wb-r2", dropTo: "lb-r1", isGroups: true },
    { id: "wb-r2", label: "WB QUARTERS", bracket: "wb", inputCount: 16, advanceTo: "wb-semis", dropTo: "lb-r2" },
    { id: "wb-semis", label: "WB SEMIFINALS", bracket: "wb", inputCount: 8, advanceTo: "wb-final", dropTo: "lb-r4" },
    { id: "wb-final", label: "WB FINAL", bracket: "wb", inputCount: 4, advanceTo: "cashout", dropTo: "lb-final" },
    { id: "lb-r1", label: "LB ROUND 1", bracket: "lb", inputCount: 16, advanceTo: "lb-r2" },
    { id: "lb-r2", label: "LB ROUND 2", bracket: "lb", inputCount: 16, advanceTo: "lb-r3" },
    { id: "lb-r3", label: "LB ROUND 3", bracket: "lb", inputCount: 8, advanceTo: "lb-r4" },
    { id: "lb-r4", label: "LB ROUND 4", bracket: "lb", inputCount: 8, advanceTo: "lb-semi" },
    { id: "lb-semi", label: "LB SEMIFINAL", bracket: "lb", inputCount: 4, advanceTo: "lb-final" },
    { id: "lb-final", label: "LB FINAL", bracket: "lb", inputCount: 4, advanceTo: "cashout" },
    { id: "cashout", label: "CASH-OUT FINAL", bracket: "gf", inputCount: 4, advanceTo: "gf", hasNoLBDrop: true },
    { id: "gf", label: "GRAND FINAL", bracket: "gf", inputCount: 2 },
  ];
}

// Effective pod size for a phase. gf is always 2. Otherwise use config or default 4.
// A phase with inputCount 2 can only be podSize 2.
export function effectivePodSize(phase: PhaseSpec, config: FormatConfig): PodSize {
  if (phase.forcePodSize) return phase.forcePodSize; // structural override (finals-bracket cashout)
  if (phase.inputCount === 2) return 2;
  if (phase.id === "fbracket") return 2; // head-to-head finals semis are always 2-team
  const c = config[phase.id];
  if (c === 2 || c === 4) return c;
  return phase.id === "gf" ? 2 : 4;
}

// ─── Snake seeding ─────────────────────────────────────────────────────────────
function snakeDistribute<T>(items: T[], podCount: number): T[][] {
  const pods: T[][] = Array.from({ length: podCount }, () => []);
  let idx = 0, row = 0;
  while (idx < items.length) {
    const order = Array.from({ length: podCount }, (_, i) => i);
    const ordered = row % 2 === 0 ? order : order.reverse();
    for (const p of ordered) {
      if (idx < items.length) { pods[p].push(items[idx]); idx++; }
    }
    row++;
  }
  return pods;
}

function emptySlots(n: number): TeamSlot[] {
  return Array.from({ length: n }, () => ({ name: "", placement: 0, seed: 0 }));
}

function groupLabel(i: number): string {
  return `GROUP ${String.fromCharCode(65 + i)}`;
}

// ─── Build initial pods ─────────────────────────────────────────────────────────
export function buildInitialPods(
  size: Size, seeds: SeedEntry[], mode: TournamentMode, config: FormatConfig,
  maps?: string[], rng: () => number = Math.random, opts?: EngineOptions
): Pod[] {
  const graph = getPhaseGraph(size, mode, opts);
  const pods: Pod[] = [];
  const sorted = [...seeds].sort((a, b) => a.seed - b.seed);

  for (const phase of graph) {
    const podSize = effectivePodSize(phase, config);
    const podCount = phase.id === "fbracket" ? 2 : Math.max(1, Math.ceil(phase.inputCount / podSize));

    if (phase.isGroups) {
      // Seed teams into first round
      const seedSlots: TeamSlot[] = sorted.map((s) => ({
        name: s.name, placement: 0, seed: s.seed, players: s.players ?? [],
      }));
      const distributed = snakeDistribute(seedSlots, podCount);
      for (let g = 0; g < podCount; g++) {
        // pad to podSize
        const teams = [...distributed[g]];
        while (teams.length < podSize) teams.push({ name: "", placement: 0, seed: 0 });
        pods.push({
          id: `${phase.id}-${g}`,
          label: podCount > 1 ? groupLabel(g) : phase.label,
          phase: phase.id,
          bracket: phase.bracket,
          teams,
          hasNoLBDrop: phase.hasNoLBDrop,
          // No pre-assigned map: the Discord ban phase (or the admin's map
          // picker) decides it. Renderers show "MAP TBD" until then.
        });
      }
    } else {
      for (let i = 0; i < podCount; i++) {
        pods.push({
          id: `${phase.id}-${i}`,
          label: podCount > 1 ? `${phase.label} ${i + 1}` : phase.label,
          phase: phase.id,
          bracket: phase.bracket,
          teams: emptySlots(podSize),
          hasNoLBDrop: phase.hasNoLBDrop,
        });
      }
    }
  }

  return pods;
}


// ─── Snake layout (stable index -> slot mapping) ──────────────────────────────
// Returns array where layout[globalIndex] = { pod, pos }. Based on TOTAL count,
// so a team's destination never shifts as other results come in.
function snakeLayout(total: number, podCount: number): { pod: number; pos: number }[] {
  const result: { pod: number; pos: number }[] = [];
  const fill = new Array(podCount).fill(0);
  let idx = 0, row = 0;
  while (idx < total) {
    const order = Array.from({ length: podCount }, (_, i) => i);
    const ordered = row % 2 === 0 ? order : [...order].reverse();
    for (const p of ordered) {
      if (idx < total) { result[idx] = { pod: p, pos: fill[p] }; fill[p]++; idx++; }
    }
    row++;
  }
  return result;
}

// ─── Propagation (deterministic) ───────────────────────────────────────────────
// Each pod advances its top half and (DE WB) drops its bottom half.
// A team's destination pod+slot is fixed by its SOURCE position, never by how many
// results are currently decided. This prevents teams from jumping between pods.
export function propagate(
  pods: Pod[], size: Size, mode: TournamentMode, config: FormatConfig, opts?: EngineOptions
): Pod[] {
  const graph = getPhaseGraph(size, mode, opts);
  const podMap = new Map<string, Pod>(
    pods.map((p) => [p.id, { ...p, teams: p.teams.map((t) => ({ ...t })) }])
  );
  const podsByPhase = (phaseId: string) =>
    Array.from(podMap.values()).filter((p) => p.phase === phaseId)
      .sort((a, b) => podIndex(a.id) - podIndex(b.id));

  // ─── Special case: head-to-head finals bracket ──────────────────────────────
  // The 4-team final advances ALL 4, paired by placement: 1st vs 4th -> semi A,
  // 2nd vs 3rd -> semi B. Winners of each semi go to the GF (handled generically
  // below, since fbracket advances its top 1 of 2 like any 2-team pod).
  if (opts?.finalsBracket) {
    const finalId = graph.find((p) => p.id === "cashout") ? "cashout" : "final";
    const finalPods = podsByPhase(finalId);
    const fbPods = podsByPhase("fbracket"); // [semi A, semi B]
    if (finalPods.length === 1 && fbPods.length === 2) {
      const fp = finalPods[0];
      const get = (place: Placement) => fp.teams.find((t) => t.placement === place && t.name);
      const p1 = get(1), p2 = get(2), p3 = get(3), p4 = get(4);
      const semiA = fbPods[0], semiB = fbPods[1];
      const place = (pod: Pod, slot: number, team: TeamSlot | undefined) => {
        const existing = pod.teams[slot];
        const next: TeamSlot = team
          ? { ...team, placement: existing && existing.name && team.seed > 0 && existing.seed === team.seed ? existing.placement : 0, path: team.path ?? "wb" }
          : { name: "", placement: 0, seed: 0 };
        pod.teams[slot] = next;
      };
      // Semi A: 1st (top) vs 4th (bottom); Semi B: 2nd (top) vs 3rd (bottom)
      place(semiA, 0, p1); place(semiA, 1, p4);
      place(semiB, 0, p2); place(semiB, 1, p3);
    }
  }

  // For each destination phase, compute its incoming contributions in a FIXED order:
  //   advance-kind contributions first (by source graph order), then drop-kind.
  // Each contribution occupies a fixed block of global indices in the destination.
  interface Contribution { sourceId: string; kind: "advance" | "drop"; count: number; offset: number; perPod: number; advanceCount: number; }
  const contributionsByDest = new Map<string, Contribution[]>();

  for (const dest of graph) {
    if (dest.isGroups) continue;
    if (dest.id === "fbracket") continue; // filled by the special case above
    const advanceSources = graph.filter((s) => s.advanceTo === dest.id);
    const dropSources = mode === "double"
      ? graph.filter((s) => s.dropTo === dest.id && !s.hasNoLBDrop)
      : [];
    const contribs: Contribution[] = [];
    let offset = 0;
    const addContrib = (s: PhaseSpec, kind: "advance" | "drop") => {
      const ps = effectivePodSize(s, config);
      const advanceCount = ps / 2;
      const sourcePods = Math.max(1, Math.ceil(s.inputCount / ps));
      const perPod = advanceCount; // advancers per pod == droppers per pod == ps/2
      const count = sourcePods * perPod;
      contribs.push({ sourceId: s.id, kind, count, offset, perPod, advanceCount });
      offset += count;
    };
    for (const s of advanceSources) addContrib(s, "advance");
    for (const s of dropSources) addContrib(s, "drop");
    if (contribs.length) contributionsByDest.set(dest.id, contribs);
  }

  // Fill each destination phase deterministically
  for (const dest of graph) {
    if (dest.isGroups) continue;
    const contribs = contributionsByDest.get(dest.id);
    if (!contribs) continue;
    const destPodSize = effectivePodSize(dest, config);
    const expectedPods = dest.id === "fbracket" ? 2 : Math.max(1, Math.ceil(dest.inputCount / destPodSize));
    const destPods = podsByPhase(dest.id).slice(0, expectedPods);
    if (destPods.length === 0) continue;
    const total = contribs.reduce((sum, c) => sum + c.count, 0);
    const layout = snakeLayout(total, destPods.length);

    // Only the graph-expected pods receive teams: the GF phase may carry extra
    // Bo3 game pods (gf-1/gf-2, same phase) that are filled by the series step
    // below, never by generic propagation.
    const newTeamsByPod: TeamSlot[][] = destPods.map(() =>
      Array.from({ length: destPodSize }, () => ({ name: "", placement: 0, seed: 0 } as TeamSlot))
    );

    for (const c of contribs) {
      const sourcePods = podsByPhase(c.sourceId);
      for (let sp = 0; sp < sourcePods.length; sp++) {
        const pod = sourcePods[sp];
        // for each local placement slot in this source pod
        for (let local = 0; local < c.perPod; local++) {
          const placement = c.kind === "advance" ? local + 1 : c.advanceCount + local + 1;
          const team = pod.teams.find((t) => t.placement === placement && t.name);
          if (!team) continue;
          const globalIndex = c.offset + sp * c.perPod + local;
          const slot = layout[globalIndex];
          if (!slot) continue;
          newTeamsByPod[slot.pod][slot.pos] = {
            ...team,
            placement: 0,
            path: c.kind === "drop" ? "lb" : (phaseBracket(c.sourceId, graph) === "lb" ? "lb" : "wb"),
          };
        }
      }
    }

    // Apply, preserving existing placements where the same team occupies the same slot
    for (let i = 0; i < destPods.length; i++) {
      const dpod = destPods[i];
      const computed = newTeamsByPod[i];
      for (let s = 0; s < computed.length; s++) {
        const old = dpod.teams[s];
        if (old && old.name && old.seed > 0 && old.seed === computed[s].seed) {
          computed[s] = { ...computed[s], placement: old.placement };
        }
      }
      dpod.teams = computed;
    }
  }

  // ─── Grand-final Bo3 series ─────────────────────────────────────────────────
  // The GF is best-of-3, visualised progressively: game 2 appears under game 1
  // once it is played; game 3 only on a 1-1 tie. Extra game pods share the "gf"
  // phase (same rendering column) but are invisible to generic propagation
  // (destPods sliced to the graph-expected count above). Removing or changing
  // an upstream result shrinks the series back automatically.
  {
    const gfGames = podsByPhase("gf");
    const g0 = gfGames[0];
    if (g0 && g0.teams.length === 2 && g0.teams.every((t) => t.name)) {
      const series = gfSeries(gfGames);
      const desired = series.champion ? series.playedCount : Math.min(3, series.playedCount + 1);
      for (const g of gfGames.slice(desired)) podMap.delete(g.id);
      g0.label = desired > 1 ? "GAME 1" : "GRAND FINAL";
      for (let i = 1; i < desired; i++) {
        const id = `gf-${i}`;
        let g = podMap.get(id);
        if (!g) {
          // A streamed grand final is streamed for the WHOLE series: every new
          // game inherits the previous game's onStream flag, so the bot never
          // tells the finalists to self-host a lobby mid-series. liveNow is
          // not inherited - the observer flips it per broadcast.
          const prev = podMap.get(`gf-${i - 1}`) ?? g0;
          g = { id, label: `GAME ${i + 1}`, phase: "gf", bracket: "gf", teams: [], onStream: prev.onStream };
          podMap.set(id, g);
        }
        g.teams = g0.teams.map((src, si) => {
          const old = g!.teams[si];
          const keep = old && old.name === src.name;
          return { name: src.name, seed: src.seed, players: src.players, path: src.path, placement: keep ? old.placement : 0 };
        });
      }
    } else if (g0) {
      // Finalists not decided yet: no series pods, classic single GF pod.
      for (const g of gfGames.slice(1)) podMap.delete(g.id);
      g0.label = "GRAND FINAL";
    }
  }

  return Array.from(podMap.values());
}

// Best-of-3 series state over the GF game pods (pass them in game order).
// Wins are counted over consecutive fully-played games. `champion` strictly
// means two series wins (what propagation needs). `displayChampion` adds the
// legacy case — a lone GF pod from a pre-Bo3 state or archive, where the
// single game winner is the champion (renderers should use this one).
export function gfSeries(gfGames: Pod[]): {
  playedCount: number; champion: string | null; displayChampion: string | null;
  decidingId: string | null; wins: Record<string, number>;
} {
  const wins: Record<string, number> = {};
  let playedCount = 0, champion: string | null = null, decidingId: string | null = null;
  let lastWinner: string | null = null, lastPlayedId: string | null = null;
  for (const g of gfGames) {
    const played = g.teams.length >= 2 && g.teams.every((t) => t.name && t.placement > 0);
    if (!played || champion) break;
    playedCount++;
    const w = g.teams.find((t) => t.placement === 1);
    if (!w) continue;
    lastWinner = w.name; lastPlayedId = g.id;
    wins[w.name] = (wins[w.name] || 0) + 1;
    if (wins[w.name] >= 2) { champion = w.name; decidingId = g.id; }
  }
  const displayChampion = champion ?? (gfGames.length === 1 && playedCount === 1 ? lastWinner : null);
  return {
    playedCount, champion, displayChampion,
    decidingId: decidingId ?? (displayChampion ? lastPlayedId : null),
    wins,
  };
}

function podIndex(podId: string): number {
  const m = podId.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}
function phaseBracket(phaseId: string, graph: PhaseSpec[]): Bracket {
  return graph.find((p) => p.id === phaseId)?.bracket ?? "wb";
}

// ─── Phase ordering for render ────────────────────────────────────────────────
export function getPhaseOrder(size: Size, mode: TournamentMode, opts?: EngineOptions): string[] {
  return getPhaseGraph(size, mode, opts).map((p) => p.id);
}
