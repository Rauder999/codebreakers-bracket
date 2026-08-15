/* ==========================================================================
   CodeBreakers match-stats embed.

   Drop-in widget for the public bracket site (live.html). Given a session code
   and a pod id it fetches the recorded per-player stats and renders them into
   a container. No dependencies, no build step, no globals beyond CBStats.

     <script src=".../cb-stats-embed.js"
             data-api="https://STATS-HOST"></script>

     CBStats.mount(document.querySelector("#match-stats"), {
       code: "CB-7EQG", podId: "groups-0"
     });

   Styling deliberately inherits the host page's font and colours -- it reads
   the surrounding text colour and draws its own hairlines from currentColor at
   low alpha, so it sits inside a light or dark bracket without configuration.

   If a match has no stats recorded (nobody submitted a screenshot, or a
   moderator entered the result by hand) mount() renders nothing at all and
   resolves false. It never shows an error to a spectator.
   ========================================================================== */
(function (global) {
  "use strict";

  var script = document.currentScript;
  var DEFAULT_API = (script && script.dataset && script.dataset.api) || "";
  var STYLE_ID = "cb-stats-embed-style";

  var CSS = [
    ".cbse{font:inherit;color:inherit;margin:16px 0}",
    ".cbse *{box-sizing:border-box}",
    ".cbse-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:10px}",
    ".cbse-title{font-weight:700;font-size:14px}",
    ".cbse-meta{font-size:12px;opacity:.65}",
    ".cbse-team{margin:0 0 14px;border:1px solid rgba(127,127,127,.28);border-radius:10px;overflow:hidden}",
    ".cbse-teamhead{display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(127,127,127,.10);font-size:13px}",
    ".cbse-place{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:6px;font-weight:700;font-size:12px;background:rgba(127,127,127,.22)}",
    ".cbse-place.cbse-p1{background:#2a78d6;color:#fff}",
    ".cbse-name{font-weight:650}",
    ".cbse-cash{margin-left:auto;opacity:.8;font-variant-numeric:tabular-nums}",
    ".cbse-scroll{overflow-x:auto}",
    ".cbse table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}",
    ".cbse th,.cbse td{padding:6px 10px;text-align:right;white-space:nowrap;border-top:1px solid rgba(127,127,127,.18)}",
    ".cbse th:first-child,.cbse td:first-child{text-align:left}",
    ".cbse th{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;font-weight:600;border-top:0}",
    ".cbse-cls{display:inline-block;min-width:18px;text-align:center;padding:0 5px;border-radius:5px;font-size:10px;font-weight:700;color:#fff}",
    /* First three slots of the validated categorical palette; the letter
       inside the badge means class is never carried by colour alone. */
    ".cbse-cls.L{background:#2a78d6}.cbse-cls.M{background:#eb6834}.cbse-cls.H{background:#1baf7a}",
    ".cbse-cls.X{background:rgba(127,127,127,.4)}",
    ".cbse-dc{opacity:.5}",
    ".cbse-foot{font-size:11px;opacity:.55;margin-top:6px}",
  ].join("");

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  var n = function (v) { return v === null || v === undefined ? "\u2013" : Number(v).toLocaleString(); };

  function playerTable(players) {
    var wrap = el("div", "cbse-scroll");
    var table = document.createElement("table");
    var cols = ["Player", "", "E", "A", "D", "R", "K/D", "Combat", "Support", "Objective"];

    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    cols.forEach(function (c) { hr.appendChild(el("th", null, c)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    players.forEach(function (p) {
      var tr = document.createElement("tr");
      if (p.disconnected) tr.className = "cbse-dc";

      tr.appendChild(el("td", null, p.name_observed));

      var clsCell = document.createElement("td");
      var letter = p.class && "LMH".indexOf(p.class) >= 0 ? p.class : "X";
      var badge = el("span", "cbse-cls " + letter, letter === "X" ? "?" : letter);
      badge.title = { L: "Light", M: "Medium", H: "Heavy" }[p.class] || "Unknown class";
      clsCell.appendChild(badge);
      tr.appendChild(clsCell);

      [p.eliminations, p.assists, p.deaths, p.revives].forEach(function (v) { tr.appendChild(el("td", null, n(v))); });
      tr.appendChild(el("td", null, p.kd === null || p.kd === undefined ? "\u2013" : p.kd.toFixed(2)));
      [p.combat, p.support, p.objective].forEach(function (v) { tr.appendChild(el("td", null, n(v))); });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function render(container, data, opts) {
    injectStyle();
    var root = el("div", "cbse");

    if (opts.showHeader !== false) {
      var head = el("div", "cbse-head");
      head.appendChild(el("div", "cbse-title", "Match stats"));
      var bits = [];
      if (data.match.map) bits.push(data.match.map);
      if (data.match.played_at) bits.push(new Date(data.match.played_at).toLocaleString());
      if (bits.length) head.appendChild(el("div", "cbse-meta", bits.join(" \u00B7 ")));
      root.appendChild(head);
    }

    data.teams.forEach(function (t) {
      var box = el("div", "cbse-team");
      var th = el("div", "cbse-teamhead");
      var place = el("span", "cbse-place" + (t.placement === 1 ? " cbse-p1" : ""), t.placement === null || t.placement === undefined ? "\u2013" : t.placement);
      th.appendChild(place);
      th.appendChild(el("span", "cbse-name", t.name));
      if (!t.in_tournament) th.appendChild(el("span", "cbse-meta", "not in this match"));
      if (t.cash !== null && t.cash !== undefined) th.appendChild(el("span", "cbse-cash", "$" + Number(t.cash).toLocaleString()));
      box.appendChild(th);
      box.appendChild(playerTable(t.players || []));
      root.appendChild(box);
    });

    root.appendChild(el("div", "cbse-foot", "Read from the end-of-match scoreboard. Corrections are made by tournament moderators."));

    container.replaceChildren ? container.replaceChildren(root) : (container.innerHTML = "", container.appendChild(root));
  }

  /**
   * @param container element to render into
   * @param opts { code, podId, matchId, api, showHeader }
   * @returns Promise<boolean> true if stats were rendered
   */
  function mount(container, opts) {
    opts = opts || {};
    var api = (opts.api || DEFAULT_API || "").replace(/\/$/, "");
    if (!container) return Promise.resolve(false);
    if (!api) { console.warn("CBStats: no API base configured"); return Promise.resolve(false); }

    var url = opts.matchId
      ? api + "/api/public/match?id=" + encodeURIComponent(opts.matchId)
      : api + "/api/public/match?code=" + encodeURIComponent(opts.code) + "&pod=" + encodeURIComponent(opts.podId);

    return fetch(url, { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        // No stats for this match is the normal case for a hand-entered
        // result: render nothing rather than an error.
        if (!data || !data.ok || !data.teams || !data.teams.length) {
          if (container.replaceChildren) container.replaceChildren(); else container.innerHTML = "";
          return false;
        }
        render(container, data, opts);
        return true;
      })
      .catch(function (e) {
        console.warn("CBStats: " + e.message);
        return false;
      });
  }

  /** List every match that has stats, so the bracket can mark them. */
  function listMatches(code, opts) {
    opts = opts || {};
    var api = (opts.api || DEFAULT_API || "").replace(/\/$/, "");
    if (!api) return Promise.resolve([]);
    return fetch(api + "/api/public/matches?tournament=" + encodeURIComponent(code), { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.ok ? d.matches : []; })
      .catch(function () { return []; });
  }

  global.CBStats = { mount: mount, listMatches: listMatches, api: DEFAULT_API };
}(window));
