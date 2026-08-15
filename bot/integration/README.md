# Match stats on the bracket site

This adds a **Stats** panel to `live.html`: click a match, see every player's
class, eliminations, assists, deaths, revives, combat / support / objective
score, K/D, and the team's cash — read from the end-of-match scoreboard that the
Discord bot already processes.

Nothing here changes the bracket, the worker, or the chat. It is three small
additions to `live.html` plus one `<script>` tag. If a match has no stats
recorded, the panel simply does not open — spectators never see an error.

Written against `live.html` as published on 2026-08-01. Line numbers will drift;
the anchors quoted below are what to search for.

---

## 0. Before you start

The stats service must know your origin or the browser will block the request.
Tell whoever runs the VM which origin to allow — it is one line in
`config.json` under `stats.publicOrigins`, already set to:

```
https://rauder999.github.io
```

If the bracket ever moves to a custom domain, that list needs the new origin
too. The stats API base URL is referred to below as `STATS_BASE`.

---

## 1. Add the embed script

Copy `cb-stats-embed.js` into the repo (next to `live.html` is fine) and add
this **above** the existing `<script>` block — the one that starts with
`const WORKER_URL = ...`:

```html
<script src="./cb-stats-embed.js" data-api="STATS_BASE"></script>
```

Replace `STATS_BASE` with the real host. The script is dependency-free, ~6 KB,
and defines exactly one global: `CBStats`.

---

## 2. Add the stats drawer

Find the match chat drawer:

```html
  <!-- ─── Match chat drawer (participants + admins only) ─── -->
  <div class="chat-drawer" id="chatDrawer">
```

Add this block **immediately before** it. It reuses the existing
`.chat-drawer` / `.chat-head` / `.chat-close` styles, so it matches the chat
panel without any new CSS:

```html
  <!-- ─── Match stats drawer (public) ─── -->
  <div class="chat-drawer" id="statsDrawer">
    <div class="chat-head">
      <span id="statsTitle" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">MATCH STATS</span>
      <button class="chat-close" onclick="closeStats()">&#10005;</button>
    </div>
    <div class="chat-msgs" id="statsBody" style="padding:12px"></div>
  </div>
```

---

## 3. Add the open/close functions

Find `function openChat(podId) {` and add these two functions next to it:

```js
    function openStats(podId) {
      document.getElementById("statsTitle").textContent = podLabelById(podId);
      const body = document.getElementById("statsBody");
      body.innerHTML = `<div class="chat-empty">Loading...</div>`;
      document.getElementById("statsDrawer").classList.add("open");
      CBStats.mount(body, { code: currentSession, podId, showHeader: false })
        .then(function (shown) {
          if (!shown) body.innerHTML = `<div class="chat-empty">No stats recorded for this match yet.</div>`;
        });
    }
    function closeStats() {
      document.getElementById("statsDrawer").classList.remove("open");
    }
```

`currentSession` and `podLabelById` already exist in the file — no new state.

---

## 4. Add the button to each match

Find this line inside `renderPod`:

```js
      html += `<div class="${headerCls}">${pod.label}${streamBadge}</div>`;
```

Replace it with:

```js
      const statsBtn = pod.teams.every(t => t.placement)
        ? ` <button class="pod-chat-btn" title="Match stats" onclick="event.stopPropagation();openStats('${pod.id}')">&#9783;</button>`
        : "";
      html += `<div class="${headerCls}">${pod.label}${streamBadge}${statsBtn}</div>`;
```

The button only appears once a match has been decided, which is also the only
time stats can exist. It reuses the existing `.pod-chat-btn` style.

---

## That's it

Four edits, no build step, no new dependencies.

### Checking it works

Open the browser console on a finished tournament and run:

```js
CBStats.listMatches(currentSession).then(console.log)
```

That returns every match with stats recorded. If it returns `[]`, either no
screenshots were processed for that tournament or the origin is not on the
allowlist (the console will show a CORS error in the second case).

### Notes

- **The panel is public.** It shows only what was already visible on the
  end-of-match scoreboard to everyone in the lobby. No Discord identities, no
  private chat, no roster contact details.
- **Corrections propagate.** If a moderator fixes a misread number on the stats
  site, the panel shows the corrected value the next time it is opened. K/D and
  every average are recomputed from the stored totals, never cached.
- **Squads from outside the bracket** (when a tournament match shares a lobby
  with other players) are shown greyed with "not in this match", and are
  excluded from all team and player aggregates.
- `CBStats.mount()` returns a promise resolving `true`/`false`, so you can use
  it to decide whether to show a tab at all.
