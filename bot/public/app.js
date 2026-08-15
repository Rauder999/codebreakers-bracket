/* ==========================================================================
   CodeBreakers stats -- single-page client. No build step, no dependencies.

   Every number shown here is derived server-side from stored sums (see
   web/queries.js). Nothing on this page recomputes a rate from a rate.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");

let ME = null;
let FILTERS = { tournament: "", class: "", map: "", min_matches: "", from: "", to: "" };
let LOOKUPS = { tournaments: [], maps: [] };

// --- helpers ---------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || (data && data.ok === false)) {
    const err = new Error((data && data.error) || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "style") node.setAttribute("style", v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const num = (v, d = 0) => (v === null || v === undefined ? "\u2013" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (v) => (v === null || v === undefined ? "\u2013" : "$" + Number(v).toLocaleString());
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "\u2013");

const classBadge = (c) => el("span", { class: `cls ${c && "LMH".includes(c) ? c : "unknown"}`, title: { L: "Light", M: "Medium", H: "Heavy" }[c] || "Unknown class" }, c || "?");
const placeBadge = (p) => el("span", { class: `place${p === 1 ? " p1" : ""}` }, p == null ? "\u2013" : p);

function qs(extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...FILTERS, ...extra })) {
    if (v !== "" && v !== null && v !== undefined) p.set(k, v);
  }
  return p.toString();
}

function setBusy(msg = "Loading...") { main.replaceChildren(el("div", { class: "empty" }, msg)); }
function showError(e) {
  main.replaceChildren(el("div", { class: "card" },
    el("h2", {}, "Something went wrong"),
    el("p", { class: "error" }, e.message)));
}

// --- reusable table --------------------------------------------------------

/**
 * columns: [{ key, label, left?, fmt?, sortable?, bar? }]
 * sort: { key, dir } -- when onSort is given the header becomes clickable.
 */
function dataTable(rows, columns, { sort, onSort, rowHref, rowId, emptyText = "No data yet." } = {}) {
  if (!rows.length) return el("div", { class: "empty" }, emptyText);

  // Bar widths are scaled to the largest value in that column, magnitude only.
  const maxes = {};
  for (const c of columns) {
    if (c.bar) maxes[c.key] = Math.max(...rows.map((r) => Number(r[c.key]) || 0), 0) || 1;
  }

  const head = el("tr", {}, columns.map((c) => {
    const attrs = { class: [c.left ? "left" : "", c.sortable && onSort ? "sortable" : ""].filter(Boolean).join(" ") };
    if (sort && sort.key === c.key) attrs["aria-sort"] = sort.dir === "asc" ? "ascending" : "descending";
    if (c.title) attrs.title = c.title;
    if (c.sortable && onSort) attrs.onclick = () => onSort(c.key);
    return el("th", attrs, c.label);
  }));

  // The cell carries its column key and the row its record id, so features
  // like the moderator editor can find a cell without counting columns.
  const body = rows.map((r) => el("tr", { "data-id": rowId ? rowId(r) : null }, columns.map((c) => {
    const raw = r[c.key];
    const content = c.fmt ? c.fmt(r) : num(raw);
    const attrs = {
      class: [c.left ? "left" : "num", c.bar ? "bar" : ""].filter(Boolean).join(" "),
      "data-key": c.key,
    };
    if (c.bar) attrs.style = `--w:${Math.max(0, (Number(raw) || 0) / maxes[c.key] * 100)}%`;
    return el("td", attrs, el("span", {}, content));
  })));

  if (rowHref) body.forEach((tr, i) => {
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => { location.hash = rowHref(rows[i]); });
  });

  return el("div", { class: "scroll" }, el("table", {}, el("thead", {}, head), el("tbody", {}, body)));
}

// --- filter bar ------------------------------------------------------------

function filterBar(onChange, { showClass = true, showMap = true, showMin = true } = {}) {
  const mk = (label, key, options) => el("div", { class: "field" },
    el("label", { for: `f-${key}` }, label),
    el("select", {
      id: `f-${key}`,
      onchange: (e) => { FILTERS[key] = e.target.value; onChange(); },
    }, options.map((o) => el("option", { value: o.value, selected: FILTERS[key] === o.value }, o.label))));

  const bar = el("div", { class: "filters" });

  bar.append(mk("Tournament", "tournament", [{ value: "", label: "All tournaments" }]
    .concat(LOOKUPS.tournaments.map((t) => ({ value: t.code, label: `${t.name || t.code} (${t.matches})` })))));

  if (showClass) bar.append(mk("Class", "class", [
    { value: "", label: "All classes" }, { value: "L", label: "Light" },
    { value: "M", label: "Medium" }, { value: "H", label: "Heavy" },
  ]));

  if (showMap) bar.append(mk("Map", "map", [{ value: "", label: "All maps" }]
    .concat(LOOKUPS.maps.map((m) => ({ value: m.map, label: `${m.map} (${m.matches})` })))));

  if (showMin) bar.append(el("div", { class: "field" },
    el("label", { for: "f-min" }, "Min matches"),
    el("input", {
      id: "f-min", type: "number", min: "0", placeholder: "0", value: FILTERS.min_matches,
      style: "min-width:100px",
      onchange: (e) => { FILTERS.min_matches = e.target.value; onChange(); },
    })));

  bar.append(el("div", { class: "field" },
    el("label", {}, "\u00A0"),
    el("button", {
      class: "btn",
      onclick: () => { FILTERS = { tournament: "", class: "", map: "", min_matches: "", from: "", to: "" }; onChange(); },
    }, "Reset")));

  return bar;
}

// --- views -----------------------------------------------------------------

const METRICS = [
  { key: "kd", label: "K/D", title: "Eliminations divided by deaths. Deaths of 0 fall back to raw eliminations." },
  { key: "eliminations", label: "Elims" },
  { key: "assists", label: "Assists" },
  { key: "deaths", label: "Deaths" },
  { key: "revives", label: "Revives" },
  { key: "combat", label: "Combat" },
  { key: "support", label: "Support" },
  { key: "objective", label: "Objective" },
  { key: "elims_per_match", label: "Elims/match" },
  { key: "combat_per_match", label: "Combat/match" },
  { key: "wins", label: "Wins" },
  { key: "avg_placement", label: "Avg placement" },
  { key: "matches", label: "Matches" },
];

let LB = { group_by: "player", sort: "kd", dir: "desc" };

async function viewLeaderboard() {
  setBusy();
  const data = await api(`/api/leaderboard?${qs({ group_by: LB.group_by, sort: LB.sort, dir: LB.dir, limit: 200 })}`);

  const controls = el("div", { class: "filters" },
    el("div", { class: "field" },
      el("label", { for: "lb-group" }, "Group by"),
      el("select", { id: "lb-group", onchange: (e) => { LB.group_by = e.target.value; render(); } },
        [["player", "Player"], ["team", "Team"], ["class", "Class"], ["map", "Map"], ["tournament", "Tournament"]]
          .map(([v, l]) => el("option", { value: v, selected: LB.group_by === v }, l)))),
    el("div", { class: "field" },
      el("label", { for: "lb-sort" }, "Rank by"),
      el("select", { id: "lb-sort", onchange: (e) => { LB.sort = e.target.value; render(); } },
        METRICS.map((m) => el("option", { value: m.key, selected: LB.sort === m.key }, m.label)))),
    el("div", { class: "field" },
      el("label", {}, "\u00A0"),
      el("a", { class: "btn", href: `/api/export.csv?${qs({ group_by: LB.group_by, sort: LB.sort, dir: LB.dir })}` }, "Export CSV")));

  const leading = METRICS.find((m) => m.key === LB.sort) || METRICS[0];
  const columns = [
    { key: "rank", label: "#", left: true, fmt: (r) => r.rank },
    {
      key: "label", label: LB.group_by === "player" ? "Player" : LB.group_by, left: true,
      fmt: (r) => (LB.group_by === "player" || LB.group_by === "team")
        ? el("a", { href: `#/${LB.group_by}s/${r.key}` }, r.label || "\u2013")
        : (r.label || "\u2013"),
    },
    { key: "matches", label: "Matches", sortable: true },
    { key: leading.key, label: leading.label, title: leading.title, bar: true, sortable: true, fmt: (r) => num(r[leading.key], 2) },
  ];
  // Then the rest of the metrics, minus whichever is already the leading column.
  for (const m of ["kd", "eliminations", "assists", "deaths", "revives", "combat", "support", "objective", "win_rate", "avg_placement"]) {
    if (m === leading.key || m === "matches") continue;
    const meta = METRICS.find((x) => x.key === m);
    columns.push({
      key: m, sortable: true, title: meta && meta.title,
      label: meta ? meta.label : (m === "win_rate" ? "Win %" : m),
      fmt: (r) => (m === "kd" || m === "avg_placement" || m === "win_rate" ? num(r[m], m === "win_rate" ? 1 : 2) : num(r[m])),
    });
  }

  const rows = data.rows.map((r, i) => ({ ...r, rank: i + 1 }));
  main.replaceChildren(
    filterBar(render),
    controls,
    el("div", { class: "card" },
      el("h2", {}, "Leaderboard", el("span", { class: "sub" }, `${rows.length} rows`)),
      dataTable(rows, columns, {
        sort: { key: LB.sort, dir: LB.dir },
        onSort: (key) => {
          if (LB.sort === key) LB.dir = LB.dir === "desc" ? "asc" : "desc";
          else { LB.sort = key; LB.dir = "desc"; }
          render();
        },
        emptyText: "No stats match these filters yet.",
      })));
}

async function viewPlayers(query = "") {
  setBusy();
  const path = query ? `/api/players?q=${encodeURIComponent(query)}` : `/api/players?${qs({ sort: "matches", limit: 200 })}`;
  const data = await api(path);

  const search = el("div", { class: "filters" },
    el("div", { class: "field", style: "flex:1" },
      el("label", { for: "psearch" }, "Search players"),
      el("input", {
        id: "psearch", type: "search", value: query,
        placeholder: "Embark ID or Discord username\u2026",
        oninput: debounce((e) => { location.hash = e.target.value ? `#/players?q=${encodeURIComponent(e.target.value)}` : "#/players"; }, 300),
      })));

  const columns = query
    ? [
      { key: "embark_id", label: "Player", left: true, fmt: (r) => el("a", { href: `#/players/${r.id}` }, r.embark_id) },
      { key: "discord_username", label: "Discord", left: true, fmt: (r) => r.discord_username || "\u2013" },
      { key: "teams", label: "Teams", left: true, fmt: (r) => (r.teams.length ? r.teams.join(", ") : "\u2013") },
      { key: "matches", label: "Matches" },
    ]
    : [
      { key: "label", label: "Player", left: true, fmt: (r) => el("a", { href: `#/players/${r.key}` }, r.label) },
      { key: "matches", label: "Matches", bar: true },
      { key: "kd", label: "K/D", fmt: (r) => num(r.kd, 2) },
      { key: "eliminations", label: "Elims" },
      { key: "assists", label: "Assists" },
      { key: "deaths", label: "Deaths" },
      { key: "revives", label: "Revives" },
      { key: "combat", label: "Combat" },
      { key: "support", label: "Support" },
      { key: "objective", label: "Objective" },
      { key: "win_rate", label: "Win %", fmt: (r) => num(r.win_rate, 1) },
    ];

  main.replaceChildren(
    query ? search : el("div", {}, search, filterBar(render, { showClass: true, showMap: true })),
    el("div", { class: "card" },
      el("h2", {}, query ? `Search: "${query}"` : "All players", el("span", { class: "sub" }, `${data.players.length} found`)),
      dataTable(data.players, columns, { emptyText: query ? "No players match that search." : "No player stats recorded yet." })));
}

function tiles(totals) {
  if (!totals) return el("div", { class: "empty" }, "No matches recorded yet.");
  const t = (v, k, n) => el("div", { class: "tile" }, el("div", { class: "v" }, v), el("div", { class: "k" }, k), n ? el("div", { class: "n" }, n) : null);
  return el("div", { class: "tiles" },
    t(num(totals.kd, 2), "K/D", `${num(totals.eliminations)} elims / ${num(totals.deaths)} deaths`),
    t(num(totals.matches), "Matches", `${num(totals.wins)} won \u00B7 ${num(totals.win_rate, 1)}%`),
    t(num(totals.avg_placement, 2), "Avg placement"),
    t(num(totals.elims_per_match, 2), "Elims / match"),
    t(num(totals.combat_per_match, 0), "Combat / match", `${num(totals.combat)} total`),
    t(num(totals.support_per_match, 0), "Support / match", `${num(totals.support)} total`),
    t(num(totals.objective_per_match, 0), "Objective / match", `${num(totals.objective)} total`),
    t(num(totals.revives), "Revives", `${num(totals.revives_per_match, 2)} / match`));
}

const SPLIT_COLUMNS = [
  { key: "label", label: "", left: true, fmt: (r) => r.label || "\u2013" },
  { key: "matches", label: "Matches" },
  { key: "kd", label: "K/D", fmt: (r) => num(r.kd, 2) },
  { key: "elims_per_match", label: "Elims/m", fmt: (r) => num(r.elims_per_match, 2) },
  { key: "combat_per_match", label: "Combat/m", fmt: (r) => num(r.combat_per_match, 0) },
  { key: "support_per_match", label: "Support/m", fmt: (r) => num(r.support_per_match, 0) },
  { key: "objective_per_match", label: "Obj/m", fmt: (r) => num(r.objective_per_match, 0) },
  { key: "win_rate", label: "Win %", fmt: (r) => num(r.win_rate, 1) },
];

async function viewPlayer(id) {
  setBusy();
  const d = await api(`/api/players/${id}`);
  const p = d.player;

  main.replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, p.embark_id,
        el("span", { class: "sub" }, p.discord_username ? `Discord: ${p.discord_username}` : "Discord unknown")),
      el("div", { class: "note" },
        d.teams.length
          ? ["Teams: ", d.teams.map((t, i) => [i ? ", " : "", el("a", { href: `#/teams/${t.id}` }, `${t.name} (${t.tournament_code})`)])]
          : "Not on any registered roster.")),
    tiles(d.totals),
    el("div", { class: "card" }, el("h2", {}, "By class"),
      dataTable(d.by_class, [{ ...SPLIT_COLUMNS[0], label: "Class", fmt: (r) => classBadge(r.label) }, ...SPLIT_COLUMNS.slice(1)], { emptyText: "No class data." })),
    el("div", { class: "card" }, el("h2", {}, "By tournament"),
      dataTable(d.by_tournament, [{ ...SPLIT_COLUMNS[0], label: "Tournament" }, ...SPLIT_COLUMNS.slice(1)], { emptyText: "No tournament data." })),
    el("div", { class: "card" }, el("h2", {}, "By map"),
      dataTable(d.by_map, [{ ...SPLIT_COLUMNS[0], label: "Map" }, ...SPLIT_COLUMNS.slice(1)], { emptyText: "No map data." })),
    el("div", { class: "card" }, el("h2", {}, "Match log"),
      dataTable(d.matches, [
        { key: "played_at", label: "When", left: true, fmt: (r) => el("a", { href: `#/matches/${r.match_id}` }, when(r.played_at)) },
        { key: "label", label: "Match", left: true, fmt: (r) => `${r.label || r.pod_id} \u00B7 ${r.tournament_code}` },
        { key: "map", label: "Map", left: true, fmt: (r) => r.map || "\u2013" },
        { key: "class", label: "Class", fmt: (r) => classBadge(r.class) },
        { key: "placement", label: "Place", fmt: (r) => placeBadge(r.placement) },
        { key: "eliminations", label: "E" }, { key: "assists", label: "A" },
        { key: "deaths", label: "D" }, { key: "revives", label: "R" },
        { key: "combat", label: "Combat" }, { key: "support", label: "Support" }, { key: "objective", label: "Objective" },
        { key: "team_cash", label: "Team cash", fmt: (r) => money(r.team_cash) },
      ], { emptyText: "No matches recorded." })));
}

async function viewTeams() {
  setBusy();
  const data = await api(`/api/teams?${qs({ sort: "matches", limit: 200 })}`);
  main.replaceChildren(
    filterBar(render, { showClass: false }),
    el("div", { class: "card" },
      el("h2", {}, "Teams", el("span", { class: "sub" }, `${data.teams.length} rows`)),
      dataTable(data.teams, [
        { key: "label", label: "Team", left: true, fmt: (r) => el("a", { href: `#/teams/${r.key}` }, r.label) },
        { key: "matches", label: "Matches", bar: true },
        { key: "wins", label: "Wins" },
        { key: "win_rate", label: "Win %", fmt: (r) => num(r.win_rate, 1) },
        { key: "avg_placement", label: "Avg place", fmt: (r) => num(r.avg_placement, 2) },
        { key: "kd", label: "K/D", fmt: (r) => num(r.kd, 2) },
        { key: "eliminations", label: "Elims" },
        { key: "combat", label: "Combat" }, { key: "support", label: "Support" }, { key: "objective", label: "Objective" },
      ], { emptyText: "No team stats recorded yet." })));
}

async function viewTeam(id) {
  setBusy();
  const d = await api(`/api/teams/${id}`);
  main.replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, d.team.name, el("span", { class: "sub" }, d.team.tournament_code)),
      el("div", { class: "note" }, "Roster: ",
        d.roster.length
          ? d.roster.map((r, i) => [i ? ", " : "", el("a", { href: `#/players/${r.id}` }, r.embark_id)])
          : "not registered")),
    tiles(d.totals),
    el("div", { class: "card" }, el("h2", {}, "Players"),
      dataTable(d.players, [
        { key: "label", label: "Player", left: true, fmt: (r) => el("a", { href: `#/players/${r.key}` }, r.label) },
        ...SPLIT_COLUMNS.slice(1),
      ], { emptyText: "No player stats for this team yet." })),
    el("div", { class: "card" }, el("h2", {}, "Matches"),
      dataTable(d.matches, [
        { key: "played_at", label: "When", left: true, fmt: (r) => el("a", { href: `#/matches/${r.match_id}` }, when(r.played_at)) },
        { key: "label", label: "Match", left: true, fmt: (r) => r.label || r.pod_id },
        { key: "map", label: "Map", left: true, fmt: (r) => r.map || "\u2013" },
        { key: "placement", label: "Place", fmt: (r) => placeBadge(r.placement) },
        { key: "cash", label: "Cash", fmt: (r) => money(r.cash) },
      ], { emptyText: "No matches recorded." })));
}

async function viewMatches() {
  setBusy();
  const data = await api(`/api/matches?${qs({ limit: 200 })}`);
  main.replaceChildren(
    filterBar(render, { showClass: false, showMap: false, showMin: false }),
    el("div", { class: "card" },
      el("h2", {}, "Matches", el("span", { class: "sub" }, `${data.matches.length} recorded`)),
      dataTable(data.matches, [
        { key: "played_at", label: "When", left: true, fmt: (r) => when(r.played_at) },
        { key: "label", label: "Match", left: true, fmt: (r) => r.label || r.pod_id },
        { key: "tournament_code", label: "Tournament", left: true },
        { key: "map", label: "Map", left: true, fmt: (r) => r.map || "\u2013" },
        { key: "teams", label: "Result", left: true, fmt: (r) => r.teams || "\u2013" },
        {
          key: "confidence", label: "Confidence",
          fmt: (r) => el("span", { class: `pill ${r.confidence === "high" ? "good" : r.confidence === "low" ? "bad" : "warn"}` }, r.confidence || "?"),
        },
      ], { rowHref: (r) => `#/matches/${r.id}`, emptyText: "No matches recorded yet." })));
}

async function viewMatch(id) {
  setBusy();
  const d = await api(`/api/matches/${id}`);
  const m = d.match;

  const teamCards = d.teams.map((t) => el("div", { class: "card" },
    el("h2", {},
      placeBadge(t.placement), " ",
      t.team_id ? el("a", { href: `#/teams/${t.team_id}` }, t.name) : t.name,
      el("span", { class: "sub" },
        [t.cash != null ? money(t.cash) : null,
          !t.in_tournament ? "not in this bracket match" : null,
          t.placement_observed && t.placement_observed !== t.placement ? `on-screen placement ${t.placement_observed}` : null]
          .filter(Boolean).join(" \u00B7 "))),
    dataTable(t.players, [
      { key: "name_observed", label: "Player", left: true, fmt: (r) => (r.player_id ? el("a", { href: `#/players/${r.player_id}` }, r.name_observed) : el("span", { class: "muted" }, r.name_observed)) },
      { key: "class", label: "Class", fmt: (r) => classBadge(r.class) },
      { key: "eliminations", label: "E" },
      { key: "assists", label: "A" },
      { key: "deaths", label: "D" },
      { key: "revives", label: "R" },
      { key: "kd", label: "K/D", fmt: (r) => num(r.kd, 2) },
      { key: "combat", label: "Combat" },
      { key: "support", label: "Support" },
      { key: "objective", label: "Objective" },
      { key: "disconnected", label: "", fmt: (r) => (r.disconnected ? el("span", { class: "pill ghost" }, "DC") : "") },
    ], { rowId: (r) => r.id, emptyText: "No player rows." })));

  // Moderators can correct an OCR misread in place; every change is audited.
  if (ME && ME.is_admin) {
    for (const card of teamCards) enableEditing(card);
  }

  const warnings = [];
  if (m.map_observed && m.map_scheduled && m.map_observed !== m.map_scheduled) {
    warnings.push(`Map on screen was "${m.map_observed}" but "${m.map_scheduled}" was scheduled.`);
  }
  if (m.confidence && m.confidence !== "high") warnings.push(`Extraction confidence was ${m.confidence}.`);

  main.replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, m.label || m.pod_id,
        el("span", { class: "sub" }, [m.tournament_code, m.map, m.on_stream ? "streamed" : null].filter(Boolean).join(" \u00B7 "))),
      el("div", { class: "note" },
        `Played ${when(m.played_at)}`,
        m.submitted_by ? ` \u00B7 screenshot by ${m.submitted_by}` : "",
        m.applied_by ? ` \u00B7 confirmed by ${m.applied_by}` : ""),
      m.notes ? el("div", { class: "note" }, "Notes: ", m.notes) : null,
      warnings.length ? el("div", { class: "note" }, warnings.map((w) => el("div", {}, el("span", { class: "pill warn" }, "check"), " ", w))) : null,
      ME && ME.is_admin ? el("div", { class: "note muted" }, "You are a moderator: click any stat cell to correct it.") : null),
    ...teamCards);
}

// In-place stat correction. Click a cell, type, Enter or blur to save.
// The cell knows its field from data-key and its row from the tr's data-id,
// so nothing here depends on column order.
const EDITABLE_FIELDS = new Set(["eliminations", "assists", "deaths", "revives", "combat", "support", "objective"]);

function enableEditing(card) {
  card.querySelectorAll("tbody tr[data-id]").forEach((tr) => {
    const matchPlayerId = tr.dataset.id;
    tr.querySelectorAll("td[data-key]").forEach((td) => {
      const field = td.dataset.key;
      if (!EDITABLE_FIELDS.has(field)) return;
      td.classList.add("editable");
      td.addEventListener("click", () => {
        if (td.querySelector("input")) return;
        const before = td.textContent.trim();
        const input = el("input", { type: "number", value: before === "\u2013" ? "" : before.replace(/,/g, "") });
        td.replaceChildren(input);
        input.focus();
        input.select();

        let done = false;
        const commit = async () => {
          if (done) return;
          done = true;
          const value = input.value === "" ? null : Number(input.value);
          td.replaceChildren(el("span", {}, value == null ? "\u2013" : num(value)));
          try {
            await api(`/api/match-players/${matchPlayerId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ [field]: value }),
            });
            render(); // re-derive K/D and every dependent average from the server
          } catch (e) {
            td.replaceChildren(el("span", { class: "error" }, e.message));
          }
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") input.blur();
          if (ev.key === "Escape") { done = true; td.replaceChildren(el("span", {}, before)); }
        });
      });
    });
  });
}

// --- routing ---------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  return { parts, query: new URLSearchParams(queryPart || "") };
}

async function render() {
  const { parts, query } = parseHash();
  const view = parts[0] || "leaderboard";

  $("#nav").querySelectorAll("button").forEach((b) => {
    const active = b.dataset.view === view || (view.startsWith(b.dataset.view.slice(0, -1)) && b.dataset.view !== "leaderboard");
    if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });

  try {
    if (view === "players" && parts[1]) return await viewPlayer(parts[1]);
    if (view === "players") return await viewPlayers(query.get("q") || "");
    if (view === "teams" && parts[1]) return await viewTeam(parts[1]);
    if (view === "teams") return await viewTeams();
    if (view === "matches" && parts[1]) return await viewMatch(parts[1]);
    if (view === "matches") return await viewMatches();
    return await viewLeaderboard();
  } catch (e) {
    if (e.status === 401) return gate();
    showError(e);
  }
}

function gate(message) {
  $("#nav").hidden = true;
  $("#who").replaceChildren();
  main.replaceChildren(el("div", { class: "gate" },
    el("h1", {}, "CodeBreakers Stats"),
    el("p", {}, message || "Tournament stats for THE FINALS \u2014 per-player, per-team, every match."),
    ME === null && window.__loginConfigured === false
      ? el("p", { class: "error" }, "Discord login is not configured on this server yet.")
      : el("a", { class: "btn primary", href: `/auth/login?next=${encodeURIComponent(location.hash || "#/leaderboard")}` }, "Sign in with Discord")));
}

async function boot() {
  let me = null;
  try {
    const data = await api("/api/me");
    me = data.user;
    window.__loginConfigured = data.login_configured;
  } catch { /* server down; fall through to the gate */ }

  ME = me;
  if (!ME) return gate();

  $("#nav").hidden = false;
  // replaceChildren is the native DOM method, not el(): it stringifies a null
  // into the text "null" instead of skipping it. Filter before passing.
  $("#who").replaceChildren(...[
    ME.avatar ? el("img", { src: `https://cdn.discordapp.com/avatars/${ME.discord_id}/${ME.avatar}.png?size=64`, alt: "" }) : null,
    el("span", {}, ME.global_name || ME.username || "signed in"),
    ME.is_admin ? el("span", { class: "pill good" }, "mod") : null,
    el("button", {
      class: "btn",
      onclick: async () => { await api("/auth/logout", { method: "POST" }); location.reload(); },
    }, "Sign out"),
  ].filter(Boolean));

  const [t, m] = await Promise.all([api("/api/tournaments"), api("/api/maps")]);
  LOOKUPS = { tournaments: t.tournaments, maps: m.maps };

  $("#nav").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => { location.hash = `#/${b.dataset.view}`; });
  });
  window.addEventListener("hashchange", render);
  render();
}

boot();
