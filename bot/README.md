# CodeBreakers Bot & Automation — Handoff / Session Briefing

> Paste this whole document into a new Claude Code session (or read it yourself)
> to get full context on the CodeBreakers tournament automation. Written 2026-07-27.
> Maintainers: Rauder (owner) + Playr (VM host). Everything below is live in production.

## 1. The big picture

CodeBreakers runs THE FINALS community tournaments. The stack has three parts:

1. **Frontend** — static pages on GitHub Pages (`https://rauder999.github.io/codebreakers-bracket/`),
   repo `Rauder999/codebreakers-bracket` (public — anyone can read it; ask Rauder for
   collaborator access to push).
   - `index.html` — admin app (React/Vite, source in `client/`): bracket setup, seeds,
     live editing, Notion import, tournament archiving.
   - `live.html` — public live bracket + Discord sign-in + **private per-match chats**.
   - `overlay.html` — OBS overlay.
2. **Backend** — Cloudflare Worker **codebreakers-api**
   (`https://codebreakers-api.codebreakerstf.workers.dev`, source in `worker/`).
   - Durable Object `SessionRoom` per tournament session: authoritative bracket state,
     WebSocket broadcast to viewers, per-match chat storage, server-side access control.
   - KV: organizer accounts, invites, **tournament archives** (permanent), active-session
     index (24h TTL), Notion registration import.
3. **Discord bot** — `cb-bot`, runs on THIS VM (`codebreakers`, Ubuntu 24.04).
   Discord app "Codebreakers Bracket" (`#1006`), currently on Rauder's test server;
   before a real tournament it must be invited to the main CODE server.

## 2. The bot: what exists and works (all e2e-tested)

Everything lives in `/opt/cb-bot`. Node 22, discord.js v14, systemd service `cb-bot`
(`Restart=always`, starts on boot). This repo folder (`bot/`) is a mirror of that code —
**the VM copy is the runtime**; if you edit on the VM, please sync back to the repo.

| File | Purpose |
|---|---|
| `index.js` | Core: Discord login, session watcher, match-ready pings, role sync CLI |
| `results.js` | Screenshot result recognition (Claude vision) |
| `config.json` | `workerUrl`, `announceChannelId`, `resultsChannelId` (empty = same), `pollIntervalSec`, `model` |
| `.env` | Secrets (chmod 600): `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `BOT_SECRET` |
| `state.json` | Persistence: which pods were already announced (no double-pings across restarts) |

### 2.1 Match-ready pings (automatic)

- Polls `GET {worker}/sessions/active` every 60s, opens a read-only WebSocket per live
  session (`/session/{code}/ws`), reconnects on drop.
- A pod (match) is "ready" when every team slot is filled and nothing is placed yet.
- The **first snapshot of a session is swallowed silently** (otherwise round 1 would
  ping the whole tournament at once). Only pods that *become* ready get announced.
- Announcement = embed in `announceChannelId` + real @mentions (players resolved by
  Discord username from the tournament roster). Streamed matches (`onStream`/`liveNow`
  flags set in the admin app) get a red "wait for the moderator to DM the lobby code"
  variant; normal matches get purple "start as soon as possible".
- Dedup persists in `state.json`.

### 2.2 Screenshot result recognition (automatic + mod confirm)

Flow: participant posts a scoreboard screenshot in the results channel →
1. Bot checks the author is a **participant of an active, unplayed match** (Discord
   username matched against the roster in the live bracket state). Others are ignored.
2. Anti-replay: sha256 dedupe of the image; one pending proposal per match.
3. Claude vision (`model` from config, default `claude-opus-5`, structured output)
   extracts: is it a genuine THE FINALS scoreboard, the map, and the team ranking —
   matched against the rosters (Embark IDs) we provide in the prompt. Mid-round
   scoreboards are accepted but flagged in notes with lowered confidence.
4. Bot replies with a proposal embed (ranking, map cross-check vs the scheduled map,
   confidence, warnings) + **Apply result / Reject** buttons — moderators only
   (Manage Server permission).
5. Apply → `POST {worker}/bot/result` with the `X-Bot-Secret` header → the Durable
   Object applies placements, re-runs bracket propagation, broadcasts to all viewers —
   and the match-ready pinger automatically announces the next formed match.

Cost: ~$0.03–0.06 per screenshot (Anthropic API, billed to Rauder's key).

### 2.3 Tournament role sync (one-shot CLI)

```
cd /opt/cb-bot && node index.js sync-roles CB-XXXX ["Role Name"]
```
Creates a mentionable role (default `Tournament: <name>`) and assigns it to every
Discord username in the tournament roster; prints who wasn't found on the server.

## 3. Where the data comes from

- Teams register via a **Notion form** ("CODE Tournament Registrations" DB in Rauder's
  Notion): team name, 3× (Embark ID + Discord username), optional sub, tournament tag,
  moderation status. The admin app's **Import from Notion** button pulls approved rows
  into the bracket (worker endpoint `GET /registrations`, Notion token is a worker secret).
- The bracket state (`pods` + `seeds` with `players`/`discords` arrays) lives in the
  Durable Object and is what the bot reads over WebSocket. Discord usernames are
  normalized (lowercase, no `@`, no `#discriminator`) on both worker and bot.

## 4. Ops cheat-sheet (on this VM)

```
sudo systemctl status|restart cb-bot        # service
sudo journalctl -u cb-bot -f                # live logs
node --check /opt/cb-bot/index.js           # syntax check before restart
```

- Worker API base: `https://codebreakers-api.codebreakerstf.workers.dev`
- Read-only endpoints need no auth: `/sessions/active`, `/session/{code}`, `/archives`.
- Write endpoints: admin auth (Rauder's master password or organizer account token) or
  `X-Bot-Secret` (value in `/opt/cb-bot/.env`) for `/bot/result` only.
- Worker/frontend deploys happen from Rauder's machine (wrangler + git push), not here.
- Test etiquette: test sessions are visible in the PUBLIC gallery on live.html —
  keep them unobtrusive, in English, and delete them right after
  (`DELETE /session/{code}` with admin auth).

## 5. Done vs not done

**Done and verified end-to-end:** live bracket sync; organizer accounts; tournament
archives (public gallery); Discord OAuth + private per-match chats (participants +
mods only, admin moderation, avatars, unread dots, auto-archiving of finished-match
chats); Notion registration import; match-ready pings; screenshot results with mod
confirm; role sync CLI.

**Not done yet — the open roadmap, roughly in priority order:**

1. **Streamed-match semi-automation.** When a match flagged "on stream" forms: bot
   creates a thread, pings the moderator + captains; the mod gives the bot the private
   lobby code; bot DMs it to the captains with a placement checklist. Lobby creation
   itself stays manual (no game API).
2. **Move to the production CODE Discord server** before the next tournament: invite
   link (ask Rauder — client id `1529573475650371919`, permissions preset exists),
   update `announceChannelId`/`resultsChannelId` in `config.json`, restart.
3. **Auto role assignment** on tournament start (wire `sync-roles` to run automatically
   when a session goes live, instead of manual CLI).
4. **Full-auto results** (skip the mod confirm once accuracy stats justify it) —
   deliberately NOT enabled yet.
5. Niceties: archive delete button in the admin UI; result submission via DM;
   per-tournament stats collection.

## 6. Conventions & gotchas

- discord.js v14; the `clientReady` event (not `ready`). Members intent is required
  for mention resolution and roles.
- Keep bot source ASCII-only: write emoji/dashes in strings as `\uXXXX` escapes
  (files have historically been corrupted by encoding-mangling transfer pipes).
- `state.json` is disposable — deleting it only risks a re-ping of already-announced
  matches.
- The worker applies results authoritatively (placements + propagation) — never try
  to compute bracket advancement bot-side.
- Secrets never go in the repo (it's public). `.env` on the VM is the source of truth
  for bot secrets; worker secrets live in Cloudflare (wrangler).
