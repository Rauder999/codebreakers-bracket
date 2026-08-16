// ============================================================================
// Per-match Discord threads: setup, map bans, result submission.
//
//   * When the bracket forms a match, we open a PRIVATE thread that only that
//     match's players can see, and add them to it.
//   * Map ban phase: the pool is (teams + 1) maps; teams ban one each in seed
//     order (best seed first); the survivor becomes the match map and is
//     written back to the bracket.
//   * Then the thread explains how to start: the best-seeded team hosts the
//     lobby, or - for streamed matches - everyone waits for the observer code.
//   * Results are only analysed when a player explicitly submits them, via the
//     "Submit result" button or the /result slash command. Random images in
//     the thread are ignored, so memes never reach the vision model.
//
// Unicode is written as \uXXXX escapes on purpose: these files travel to the
// VM through pipes that have mangled raw UTF-8 before.
// ============================================================================
const fs = require("fs");
const path = require("path");
const {
  ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ApplicationCommandOptionType,
} = require("discord.js");

const STORE = path.join(__dirname, "matches.json");
const ARM_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAPS = [
  "Bernal", "Fangwai City", "Fortune Stadium", "Galaxy Estates",
  "Las Vegas Stadium", "Monaco", "Nozomi/Citadel", "Skyway Stadium",
  "Sys$Horizon",
];
const IMAGE_TYPES = { "image/png": 1, "image/jpeg": 1, "image/webp": 1, "image/gif": 1 };

const DASH = "\u2014", DOT = "\u00B7", BAN = "\uD83D\uDEAB", SWORDS = "\u2694\uFE0F";
const CAMERA = "\uD83C\uDFA5", PIN = "\uD83D\uDCCD", HOST = "\uD83C\uDFE0", CHECK = "\u2705";

module.exports = function setupMatches(ctx) {
  const { client, sessions, CFG, ENV, WORKER, norm, mainGuild, findMember, results, syncRoles, mods } = ctx;

  // Moderator override on bans/submissions: the Manage Server permission, or
  // moderator status granted with /mod add (mods.js; includes config owners).
  const isMod = (i) => !!((i.member && i.member.permissions.has(PermissionFlagsBits.ManageGuild)) || (mods && mods.isModerator(i.user.id)));

  let store = { threads: {}, channels: {} };
  try { store = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { /* fresh */ }
  if (!store.channels) store.channels = {};
  const save = () => { try { fs.writeFileSync(STORE, JSON.stringify(store)); } catch (e) { console.error("matches: state save failed:", e.message); } };

  const armed = new Map();               // `${threadId}:${userId}` -> timestamp
  const byThread = new Map();            // threadId -> match key
  const manualResults = new Map();       // userId -> in-progress /tournament result picker
  for (const [k, v] of Object.entries(store.threads)) if (v.threadId) byThread.set(v.threadId, k);

  const key = (code, podId) => `${code}:${podId}`;
  const pool = () => (Array.isArray(CFG.maps) && CFG.maps.length ? CFG.maps : DEFAULT_MAPS);
  const bansEnabled = () => CFG.mapBans !== false;
  // Per-tournament channel: bound with /tournament bind, else the config default.
  const channelFor = (code) => store.channels[code] || CFG.announceChannelId;

  // ---- roster helpers ------------------------------------------------------
  // Discords may arrive as one comma-joined string per team - expand first.
  const splitDiscords = (arr) => (arr || []).flatMap((d) => String(d).split(",")).map(norm).filter(Boolean);
  function rostersOf(s, pod) {
    const out = {};
    for (const t of pod.teams) {
      const seed = (s.seeds || []).find((sd) => sd.name === t.name);
      out[t.name] = splitDiscords(seed && seed.discords);
    }
    return out;
  }
  // Rosters straight from the live bracket state when available, so admin
  // fixes to discords mid-tournament apply to bans/submissions immediately.
  // The snapshot stored on the entry is only a fallback (session vanished).
  function liveRosters(entry) {
    const sEntry = sessions.get(entry.code);
    const s = sEntry && sEntry.lastState;
    const pod = s && Array.isArray(s.pods) ? s.pods.find((p) => p.id === entry.podId) : null;
    if (pod) {
      const fresh = rostersOf(s, pod);
      if (Object.values(fresh).some((l) => l.length)) return fresh;
    }
    return entry.rosters || {};
  }
  function teamOfUser(entry, username) {
    const u = norm(username);
    for (const [team, list] of Object.entries(liveRosters(entry))) {
      if (list.includes(u)) return team;
    }
    return null;
  }

  // Discord offers exactly one quiet way into a private thread: mentions added
  // by EDITING a message pull the users in without any notification. A fresh
  // send would ping; thread.members.add() pings "you were added" per player.
  async function silentAddMembers(thread, discords) {
    const g = await mainGuild();
    const mentions = [];
    for (const d of discords) {
      const m = g ? findMember(g, d) : null;
      if (m) mentions.push(`<@${m.id}>`);
    }
    if (!mentions.length) return 0;
    try {
      const msg = await thread.send({ content: "\u200B" });
      await msg.edit({ content: mentions.join(" ") });
      await msg.delete();
    } catch (e) { console.error("matches: silent add failed:", e.message); }
    return mentions.length;
  }
  // Best seed first; unseeded teams last, stable by name.
  function seedOrder(teams) {
    return [...teams].sort((a, b) => (a.seed || 99) - (b.seed || 99) || String(a.name).localeCompare(String(b.name)));
  }
  function pickPool(count) {
    const all = [...pool()];
    const out = [];
    while (out.length < count && all.length) out.push(...all.splice(Math.floor(Math.random() * all.length), 1));
    return out;
  }

  // ---- rendering -----------------------------------------------------------
  function banRows(entry) {
    const banned = new Set(entry.bans.map((b) => b.map));
    const buttons = entry.pool.map((m, idx) => new ButtonBuilder()
      .setCustomId(`cbmap:${entry.key}:${idx}`)
      .setLabel(m.length > 80 ? m.slice(0, 77) + "..." : m)
      .setStyle(banned.has(m) ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(banned.has(m) || !!entry.decidedMap));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return rows;
  }
  function banEmbed(entry) {
    const banned = new Map(entry.bans.map((b) => [b.map, b.team]));
    const lines = entry.pool.map((m) => banned.has(m)
      ? `${BAN} ~~${m}~~ ${DOT} banned by ${banned.get(m)}`
      : `${PIN} **${m}**`);
    const turn = entry.order[entry.bans.length];
    return {
      title: `${SWORDS} Map bans ${DASH} ${entry.label}`,
      description: [
        `Each team bans one map, best seed first. The last map standing is played.`,
        "",
        lines.join("\n"),
        "",
        entry.decidedMap
          ? `${CHECK} Map decided: **${entry.decidedMap}**`
          : `Now banning: **${turn}** ${DOT} order: ${entry.order.join(" \u2192 ")}`,
      ].join("\n"),
      color: entry.decidedMap ? 0x28d17c : 0x7c5cff,
      footer: { text: "CODEBREAKERS \u00B7 map ban" },
    };
  }
  function setupEmbed(entry) {
    const hostTeam = entry.order[0];
    const how = entry.streamed
      ? `${CAMERA} This match is **on stream** ${DASH} do not create a lobby. Wait here for the observer to send the lobby code.`
      : `${HOST} **${hostTeam}** (best seed) hosts the lobby: create a private match on **${entry.decidedMap}** and post the code in this thread.`;
    return {
      title: `${SWORDS} ${entry.label} ${DASH} ready to play`,
      description: [
        entry.order.map((t, i) => `**${i + 1}.** ${t}`).join("\n"),
        "",
        `${PIN} Map: **${entry.decidedMap || "to be decided"}**`,
        how,
        "",
        `When the match is over, one player from any team submits the end-of-match scoreboard: press **Submit result** below, or type **/result** and attach the screenshot.`,
      ].join("\n"),
      color: entry.streamed ? 0xff4d5e : 0x28d17c,
      footer: { text: "CODEBREAKERS \u00B7 match setup" },
    };
  }
  const submitRow = (k) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cbsub:${k}`).setLabel("Submit result").setStyle(ButtonStyle.Success),
  );

  // ---- thread lifecycle ----------------------------------------------------
  async function onMatchReady(code, s, pod) {
    if (CFG.matchThreads === false) return null;
    const k = key(code, pod.id);
    if (store.threads[k]) {
      try { return await client.channels.fetch(store.threads[k].threadId); } catch { /* recreate below */ }
      delete store.threads[k];
    }
    const parentId = channelFor(code);
    if (!parentId) return null;

    const ordered = seedOrder(pod.teams);

    // Bo3 grand final: every game of the series shares ONE thread, so the
    // finalists are never dragged from thread to thread - game 2/3 bans and
    // setup are simply posted below game 1 in the same place.
    let thread = null, reusedSeries = false;
    if (/^gf-\d+$/.test(pod.id)) {
      const base = Object.values(store.threads).find((e) => e.code === code && e.threadId && /^gf-\d+$/.test(e.podId) && e.podId !== pod.id);
      if (base) {
        try { thread = await client.channels.fetch(base.threadId); reusedSeries = true; }
        catch { thread = null; }
      }
    }
    if (!thread) {
      const parent = await client.channels.fetch(parentId);
      const name = `${pod.label}: ${ordered.map((t) => t.name).join(" vs ")}`.slice(0, 100);
      thread = await parent.threads.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: 1440,
        reason: `CodeBreakers match ${k}`,
      });
    }

    const rosters = rostersOf(s, pod);

    const entry = {
      key: k, code, podId: pod.id, threadId: thread.id,
      label: pod.label || "Match",
      order: ordered.map((t) => t.name),
      rosters,
      streamed: !!(pod.onStream || pod.liveNow),
      pool: [], bans: [], decidedMap: null, banMsgId: null,
    };
    store.threads[k] = entry;
    byThread.set(thread.id, k);
    save();

    // Players join silently: the channel announcement is the single ping they
    // get; the thread itself must not fire a second wave of notifications.
    // A reused series thread already has everyone in it.
    if (!reusedSeries) {
      const added = await silentAddMembers(thread, Object.values(rosters).flat());
      if (!added) console.error(`matches: no members resolved for ${k} - check discords in the bracket`);
    }

    await thread.send({
      embeds: [{
        title: `${SWORDS} ${entry.label}`,
        description: [
          entry.order.map((t, i) => `**${i + 1}.** ${t}`).join("\n"),
          "",
          entry.streamed
            ? `${CAMERA} This match is **on stream**. Bans first, then wait for the observer to send the lobby code.`
            : `Ban the maps you do not want, then the best-seeded team hosts the lobby.`,
        ].join("\n"),
        color: 0x7c5cff,
        footer: { text: "CODEBREAKERS \u00B7 only this match's players can see this thread" },
      }],
    });

    if (bansEnabled() && pod.teams.length >= 2) {
      entry.pool = pickPool(pod.teams.length + 1);
      const msg = await thread.send({ embeds: [banEmbed(entry)], components: banRows(entry) });
      entry.banMsgId = msg.id;
      save();
    } else {
      entry.decidedMap = pod.map || null;
      save();
      await thread.send({ embeds: [setupEmbed(entry)], components: [submitRow(k)] });
    }
    console.log(`matches: thread ${thread.id} for ${k} (${entry.order.join(" vs ")})`);
    return thread;
  }

  // Called on every state snapshot: when the admin fixes a team's discords
  // mid-tournament, refresh the stored rosters of that session's threads and
  // quietly pull newly added players into their thread. Nothing is re-pinged.
  // Also schedules finished matches' threads for auto-archive.
  async function onStateUpdate(code, s) {
    if (!s || !Array.isArray(s.pods)) return;
    for (const entry of Object.values(store.threads)) {
      if (entry.code !== code) continue;
      const pod = s.pods.find((p) => p.id === entry.podId);
      if (!pod) continue;

      // Match finished (every slot placed): archive the thread after a grace
      // period so only the active matches stay in the channel's thread list.
      // Grand-final games share one thread - it only closes when the SERIES
      // is over, not after game 1.
      const finished = pod.teams.length >= 2 && pod.teams.every((t) => t.name && t.placement);
      const holdForSeries = /^gf-\d+$/.test(pod.id) && !gfSeriesDecided(s);
      if (finished && !holdForSeries && !entry.closed && !entry.closeAt) {
        const min = Number(CFG.threadCloseDelayMin);
        entry.closeAt = Date.now() + (isFinite(min) && min >= 0 ? min : 10) * 60 * 1000;
        save();
      }

      const fresh = rostersOf(s, pod);
      if (JSON.stringify(fresh) === JSON.stringify(entry.rosters)) continue;
      const known = new Set(Object.values(entry.rosters || {}).flat());
      const added = Object.values(fresh).flat().filter((d) => !known.has(d));
      entry.rosters = fresh;
      save();
      if (!added.length) continue;
      try {
        const thread = await client.channels.fetch(entry.threadId);
        const n = await silentAddMembers(thread, added);
        if (n) console.log(`matches: roster fix pulled ${n} player(s) into ${entry.key}`);
      } catch (e) { console.error("matches: roster sync failed:", e.message); }
    }
  }

  // Best-of-3 grand final: the series is over when a team has two game wins
  // (or, for a legacy single-pod GF, when that one game is played).
  function gfSeriesDecided(s) {
    const games = (s.pods || []).filter((p) => p.phase === "gf")
      .sort((a, b) => (parseInt((a.id.match(/-(\d+)$/) || [])[1] || "0", 10)) - (parseInt((b.id.match(/-(\d+)$/) || [])[1] || "0", 10)));
    const wins = {};
    let played = 0;
    for (const g of games) {
      const done = g.teams.length >= 2 && g.teams.every((t) => t.name && t.placement > 0);
      if (!done) break;
      played++;
      const w = g.teams.find((t) => t.placement === 1);
      if (w) { wins[w.name] = (wins[w.name] || 0) + 1; if (wins[w.name] >= 2) return true; }
    }
    return games.length === 1 && played === 1;
  }

  // Archive sweep: runs on a timer so scheduled closes survive restarts
  // (closeAt is persisted). Archiving hides the thread from the channel's
  // active list - history stays browsable, and a moderator can always
  // unarchive. We deliberately never DELETE threads: they hold the result
  // screenshots and the ban trail, which is exactly what a dispute needs.
  async function sweepFinishedThreads() {
    const now = Date.now();
    for (const entry of Object.values(store.threads)) {
      if (entry.closed || !entry.closeAt || entry.closeAt > now) continue;
      entry.closed = true;
      // Series games share a thread: closing one game closes them all, and the
      // goodbye message must not repeat per game.
      for (const other of Object.values(store.threads)) {
        if (other !== entry && other.threadId === entry.threadId) { other.closed = true; other.closeAt = null; }
      }
      save();
      try {
        const thread = await client.channels.fetch(entry.threadId);
        await thread.send({ content: "Result recorded. Archiving this setup thread - see the announcements channel for your next match. GLHF!" });
        await thread.setArchived(true, "match finished");
        console.log(`matches: archived finished thread ${entry.key}`);
      } catch (e) { console.error(`matches: archive failed for ${entry.key}:`, e.message); }
    }
  }
  setInterval(() => { sweepFinishedThreads().catch((e) => console.error("matches sweep:", e.message)); }, 60 * 1000);

  async function finalizeMap(entry, thread) {
    const banned = new Set(entry.bans.map((b) => b.map));
    const left = entry.pool.filter((m) => !banned.has(m));
    entry.decidedMap = left[0] || entry.pool[0];
    save();
    try {
      const res = await fetch(`${WORKER}/bot/map`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bot-Secret": ENV.BOT_SECRET },
        body: JSON.stringify({ code: entry.code, podId: entry.podId, map: entry.decidedMap, editor: "Map Ban" }),
      });
      const data = await res.json();
      if (!data.ok) console.error("matches: /bot/map failed:", data.error || res.status);
    } catch (e) { console.error("matches: /bot/map error:", e.message); }
    await thread.send({ embeds: [setupEmbed(entry)], components: [submitRow(entry.key)] });
  }

  // ---- interactions --------------------------------------------------------
  async function onBanClick(i) {
    const partsCb = i.customId.split(":"); const idxStr = partsCb.pop(); const k = partsCb.slice(1).join(":");
    const entry = store.threads[k];
    if (!entry) { await i.reply({ content: "This ban button belongs to a tournament I no longer track (deleted or reset). If your match is current, ask a moderator.", ephemeral: true }); return; }
    if (entry.decidedMap) { await i.reply({ content: `The map is already decided: **${entry.decidedMap}**.`, ephemeral: true }); return; }

    const turn = entry.order[entry.bans.length];
    const myTeam = teamOfUser(entry, i.user.username);
    if (myTeam !== turn && !isMod(i)) {
      await i.reply({ content: myTeam ? `It is **${turn}**'s turn to ban.` : "Only players in this match can ban maps.", ephemeral: true });
      return;
    }
    const map = entry.pool[Number(idxStr)];
    if (!map || entry.bans.some((b) => b.map === map)) { await i.reply({ content: "That map is already banned.", ephemeral: true }); return; }

    entry.bans.push({ map, team: turn, by: i.user.username });
    save();

    const done = entry.bans.length >= entry.order.length;
    if (done) {
      const banned = new Set(entry.bans.map((b) => b.map));
      entry.decidedMap = entry.pool.find((m) => !banned.has(m)) || null;
    }
    await i.update({ embeds: [banEmbed(entry)], components: banRows(entry) });
    if (done) {
      entry.decidedMap = null; // finalizeMap recomputes and persists
      await finalizeMap(entry, i.channel);
    }
  }

  async function onSubmitClick(i) {
    const k = i.customId.split(":").slice(1).join(":");
    const entry = store.threads[k];
    if (!entry) { await i.reply({ content: "This match is no longer tracked (deleted or reset). Use /result with your screenshot instead.", ephemeral: true }); return; }
    if (!teamOfUser(entry, i.user.username) && !isMod(i)) {
      await i.reply({ content: "Only players in this match can submit its result.", ephemeral: true });
      return;
    }
    armed.set(`${i.channelId}:${i.user.id}`, Date.now());
    await i.reply({
      content: `Post the end-of-match scoreboard screenshot in this thread within 15 minutes and I will read it. (You can also use **/result** with the file attached.)`,
      ephemeral: true,
    });
  }

  function findMatchFor(entry, username) {
    // Prefer the live bracket state so placements apply to the current pod.
    const sEntry = sessions.get(entry.code);
    const s = sEntry && sEntry.lastState;
    if (!s || !Array.isArray(s.pods)) return null;
    const pod = s.pods.find((p) => p.id === entry.podId);
    if (!pod) return null;
    if (pod.teams.some((t) => t.placement)) return { done: true };
    return { code: entry.code, state: s, pod };
  }

  async function handleScreenshot({ att, entry, user, channel, respond }) {
    const found = entry ? findMatchFor(entry, user.username) : results.findMatchForUser(user.username);
    if (!found) { await respond("I could not find an active match for you. Ask a moderator to enter the result manually."); return; }
    if (found.done) { await respond("This match already has a result recorded."); return; }
    const out = await results.submit({ att, found, user, channel });
    if (out.fail) { await respond(`Could not verify this screenshot (${out.fail}). A moderator can enter the result manually.`); return; }
    await respond("Screenshot read. The proposed result is posted here and is waiting for a moderator to confirm.");
  }

  // ---- manual result entry (/tournament result) ---------------------------
  // Moderator picks placements with buttons - the fallback when nobody has a
  // screenshot. Applies through the same worker endpoint as the vision path,
  // so propagation, next-round pings and thread auto-archive all behave
  // exactly as if a screenshot had been confirmed.
  const ORD = ["1st", "2nd", "3rd", "4th", "5th"];
  function manualRows(teams, picks) {
    const buttons = teams
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => !picks.includes(t))
      .map(({ t, idx }) => new ButtonBuilder()
        .setCustomId(`cbmres:${idx}`)
        .setLabel(t.length > 80 ? t.slice(0, 77) + "..." : t)
        .setStyle(ButtonStyle.Primary));
    const rows = [];
    for (let n = 0; n < buttons.length; n += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(n, n + 5)));
    return rows;
  }

  async function onManualPick(i) {
    if (!isMod(i)) { await i.reply({ content: "Moderators only.", ephemeral: true }); return; }
    const st = manualResults.get(i.user.id);
    if (!st) { await i.reply({ content: "This picker expired (bot restarted?). Run **/tournament result** again.", ephemeral: true }); return; }
    const idx = Number(i.customId.split(":")[1]);
    const team = st.teams[idx];
    if (!team || st.picks.includes(team)) { await i.deferUpdate(); return; }
    st.picks.push(team);

    // One team left unpicked = its placement is implied; time to apply.
    if (st.picks.length >= st.teams.length - 1) {
      st.picks.push(...st.teams.filter((t) => !st.picks.includes(t)));
      manualResults.delete(i.user.id);
      const placements = {};
      st.picks.forEach((t, n) => { placements[t] = n + 1; });
      const lines = st.picks.map((t, n) => `**${n + 1}.** ${t}`).join("\n");
      try {
        const res = await fetch(`${WORKER}/bot/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bot-Secret": ENV.BOT_SECRET },
          body: JSON.stringify({ code: st.code, podId: st.podId, placements, editor: `Mod: ${i.user.username}` }),
        });
        const data = await res.json();
        if (!data.ok) { await i.update({ content: `Could not apply the result: ${data.error || res.status}`, components: [] }); return; }
      } catch (e) {
        await i.update({ content: `Could not apply the result: ${e.message}`, components: [] });
        return;
      }
      await i.update({ content: `${CHECK} Result applied:\n${lines}`, components: [] });
      try { await i.channel.send({ content: `${CHECK} Result entered manually by moderator **${i.user.username}**:\n${lines}` }); } catch { /* thread may be gone */ }
      console.log(`matches: manual result for ${st.key} by ${i.user.username}: ${st.picks.join(" > ")}`);
      return;
    }

    await i.update({
      content: `Which team finished **${ORD[st.picks.length] || (st.picks.length + 1) + "th"}**?\nSo far: ${st.picks.map((t, n) => `${n + 1}. ${t}`).join("  \u00B7  ")}`,
      components: manualRows(st.teams, st.picks),
    });
  }

  // /tournament - host-side setup. defaultMemberPermissions only hides the
  // command from players' pickers; a server admin can loosen that in the
  // integration settings, so the hard gate lives here.
  async function onTournamentCmd(i) {
    if (!isMod(i)) {
      await i.reply({ content: "Tournament setup is for moderators only.", ephemeral: true });
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === "bind") {
      const code = i.options.getString("code").toUpperCase().trim();
      if (!/^CB-[A-Z0-9]{1,12}$/.test(code)) {
        await i.reply({ content: "That does not look like a session code (expected CB-XXXX).", ephemeral: true });
        return;
      }
      store.channels[code] = i.channelId;
      save();
      await i.reply({ content: `Bound tournament **${code}** to this channel. Match announcements and private threads will be created here.`, ephemeral: true });
      return;
    }

    if (sub === "roles") {
      await i.deferReply({ ephemeral: true });
      const code = (i.options.getString("code") || [...sessions.keys()][0] || "").toUpperCase();
      if (!code) { await i.editReply("No active tournament found. Pass the session code explicitly."); return; }
      try {
        const out = await syncRoles(code, i.options.getString("role") || undefined);
        const missing = out.missing.length ? `\nNot found on this server:\n${out.missing.map((m) => `- ${m}`).join("\n")}`.slice(0, 1500) : "";
        await i.editReply(`Role **${out.name}**: assigned to ${out.added} member(s).${missing}`);
      } catch (e) {
        await i.editReply(`Role sync failed: ${e.message}`);
      }
      return;
    }

    if (sub === "result") {
      const k = byThread.get(i.channelId);
      const entry = k ? store.threads[k] : null;
      if (!entry) { await i.reply({ content: "Run this inside the match's thread so I know which match you mean.", ephemeral: true }); return; }
      const found = findMatchFor(entry, i.user.username);
      if (!found) { await i.reply({ content: "The session for this match is no longer live.", ephemeral: true }); return; }
      if (found.done) { await i.reply({ content: "This match already has a result. If it is wrong, fix the placements in the admin app.", ephemeral: true }); return; }
      const teams = found.pod.teams.map((t) => t.name).filter(Boolean);
      if (teams.length < 2) { await i.reply({ content: "This match does not have all its teams yet.", ephemeral: true }); return; }
      manualResults.set(i.user.id, { key: k, code: entry.code, podId: entry.podId, teams, picks: [] });
      await i.reply({
        content: `Manual result for **${entry.label}** ${DASH} no screenshot needed.\nWhich team finished **1st**?`,
        components: manualRows(teams, []),
        ephemeral: true,
      });
      return;
    }

    if (sub === "status") {
      const lines = [];
      for (const [code, entry] of sessions) {
        const s = entry.lastState;
        const started = s && s.tournamentStarted ? "STARTED" : "not started";
        const teams = s && s.seeds ? s.seeds.filter((x) => x.name && !String(x.name).startsWith("TBD")).length : "?";
        const ch = channelFor(code);
        const threads = Object.values(store.threads).filter((t) => t.code === code).length;
        lines.push(`**${code}** ${DOT} ${teams} teams ${DOT} ${started} ${DOT} channel ${ch ? `<#${ch}>` : "none"} ${DOT} ${threads} match thread(s)`);
      }
      await i.reply({ content: lines.length ? lines.join("\n") : "No active tournament sessions.", ephemeral: true });
      return;
    }
  }

  async function onSlash(i) {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === "tournament") { await onTournamentCmd(i); return; }
    if (i.commandName !== "result") return;
    const att = i.options.getAttachment("screenshot");
    if (!att || !IMAGE_TYPES[(att.contentType || "").split(";")[0]]) {
      await i.reply({ content: "Please attach a PNG or JPEG screenshot.", ephemeral: true });
      return;
    }
    await i.deferReply({ ephemeral: true });
    const k = byThread.get(i.channelId);
    const entry = k ? store.threads[k] : null;
    if (entry && !teamOfUser(entry, i.user.username) && !isMod(i)) {
      await i.editReply("Only players in this match can submit its result.");
      return;
    }
    await handleScreenshot({
      att, entry, user: i.user, channel: i.channel,
      respond: (text) => i.editReply(text),
    });
  }

  async function onMessage(msg) {
    if (msg.author.bot) return;
    const k = byThread.get(msg.channelId);
    if (!k) return;
    const armKey = `${msg.channelId}:${msg.author.id}`;
    const armedAt = armed.get(armKey);
    if (!armedAt) return;                       // not armed: ignore images entirely
    if (Date.now() - armedAt > ARM_WINDOW_MS) { armed.delete(armKey); return; }
    const att = [...msg.attachments.values()].find((a) => IMAGE_TYPES[(a.contentType || "").split(";")[0]]);
    if (!att) return;
    armed.delete(armKey);
    await msg.react("\uD83D\uDD0D");
    await handleScreenshot({
      att, entry: store.threads[k], user: msg.author, channel: msg.channel,
      respond: (text) => msg.reply({ content: text, allowedMentions: { repliedUser: false } }),
    });
  }

  async function registerCommands() {
    const resultCmd = {
      name: "result",
      description: "Submit your end-of-match scoreboard screenshot",
      options: [{
        name: "screenshot",
        description: "End-of-match scoreboard image",
        type: ApplicationCommandOptionType.Attachment,
        required: true,
      }],
    };
    const tournamentCmd = {
      name: "tournament",
      description: "Host tools: bind a channel, sync roles, check status",
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
      options: [
        {
          name: "bind",
          description: "Use THIS channel for a tournament's announcements and match threads",
          type: ApplicationCommandOptionType.Subcommand,
          options: [{ name: "code", description: "Session code, e.g. CB-XXXX", type: ApplicationCommandOptionType.String, required: true }],
        },
        {
          name: "roles",
          description: "Create the tournament role and assign it to every registered player",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            { name: "code", description: "Session code (default: the active one)", type: ApplicationCommandOptionType.String, required: false },
            { name: "role", description: "Custom role name (default: Tournament: <name>)", type: ApplicationCommandOptionType.String, required: false },
          ],
        },
        {
          name: "status",
          description: "Show watched tournaments, start state, bound channels",
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: "result",
          description: "Enter this match's result manually, no screenshot (run inside the match thread)",
          type: ApplicationCommandOptionType.Subcommand,
        },
      ],
    };
    for (const g of client.guilds.cache.values()) {
      try { await g.commands.set([resultCmd, tournamentCmd]); console.log(`matches: /result and /tournament registered in ${g.name}`); }
      catch (e) { console.error(`matches: command registration failed in ${g.name}:`, e.message); }
    }
  }

  client.on("interactionCreate", (i) => {
    const p = i.isButton() ? i.customId.split(":")[0] : null;
    const run = p === "cbmap" ? onBanClick(i) : p === "cbsub" ? onSubmitClick(i) : p === "cbmres" ? onManualPick(i) : onSlash(i);
    Promise.resolve(run).catch((e) => console.error("matches interaction:", e.message));
  });
  client.on("messageCreate", (m) => { onMessage(m).catch((e) => console.error("matches onMessage:", e.message)); });

  console.log("matches: threads " + (CFG.matchThreads === false ? "OFF" : "ON") + ", map bans " + (bansEnabled() ? "ON" : "OFF"));
  return { onMatchReady, onStateUpdate, registerCommands, channelFor };
};

