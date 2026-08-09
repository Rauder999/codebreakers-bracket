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
  const { client, sessions, CFG, ENV, WORKER, norm, mainGuild, findMember, results, syncRoles } = ctx;

  let store = { threads: {}, channels: {} };
  try { store = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { /* fresh */ }
  if (!store.channels) store.channels = {};
  const save = () => { try { fs.writeFileSync(STORE, JSON.stringify(store)); } catch (e) { console.error("matches: state save failed:", e.message); } };

  const armed = new Map();               // `${threadId}:${userId}` -> timestamp
  const byThread = new Map();            // threadId -> match key
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
  function teamOfUser(entry, username) {
    const u = norm(username);
    for (const [team, list] of Object.entries(entry.rosters || {})) {
      if (list.includes(u)) return team;
    }
    return null;
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
    const parent = await client.channels.fetch(parentId);
    const g = await mainGuild();

    const ordered = seedOrder(pod.teams);
    const name = `${pod.label}: ${ordered.map((t) => t.name).join(" vs ")}`.slice(0, 100);
    const thread = await parent.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 1440,
      reason: `CodeBreakers match ${k}`,
    });

    const rosters = rostersOf(s, pod);
    const mentions = [];
    for (const list of Object.values(rosters)) {
      for (const d of list) {
        const m = g ? findMember(g, d) : null;
        if (!m) continue;
        try { await thread.members.add(m.id); mentions.push(`<@${m.id}>`); } catch (e) { console.error("matches: add member failed:", e.message); }
      }
    }

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

    await thread.send({
      content: mentions.join(" ") || undefined,
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
    const [, k, idxStr] = i.customId.split(":");
    const entry = store.threads[k];
    if (!entry) { await i.reply({ content: "This ban phase is no longer tracked (bot restarted).", ephemeral: true }); return; }
    if (entry.decidedMap) { await i.reply({ content: `The map is already decided: **${entry.decidedMap}**.`, ephemeral: true }); return; }

    const turn = entry.order[entry.bans.length];
    const isMod = i.member && i.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const myTeam = teamOfUser(entry, i.user.username);
    if (myTeam !== turn && !isMod) {
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
    const k = i.customId.split(":")[1];
    const entry = store.threads[k];
    if (!entry) { await i.reply({ content: "This match is no longer tracked (bot restarted). Use /result instead.", ephemeral: true }); return; }
    const isMod = i.member && i.member.permissions.has(PermissionFlagsBits.ManageGuild);
    if (!teamOfUser(entry, i.user.username) && !isMod) {
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

  // /tournament - host-side setup, hidden from non-moderators.
  async function onTournamentCmd(i) {
    const sub = i.options.getSubcommand();

    if (sub === "bind") {
      const code = i.options.getString("code").toUpperCase();
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
    if (entry && !teamOfUser(entry, i.user.username) && !(i.member && i.member.permissions.has(PermissionFlagsBits.ManageGuild))) {
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
      ],
    };
    for (const g of client.guilds.cache.values()) {
      try { await g.commands.set([resultCmd, tournamentCmd]); console.log(`matches: /result and /tournament registered in ${g.name}`); }
      catch (e) { console.error(`matches: command registration failed in ${g.name}:`, e.message); }
    }
  }

  client.on("interactionCreate", (i) => {
    const p = i.isButton() ? i.customId.split(":")[0] : null;
    const run = p === "cbmap" ? onBanClick(i) : p === "cbsub" ? onSubmitClick(i) : onSlash(i);
    Promise.resolve(run).catch((e) => console.error("matches interaction:", e.message));
  });
  client.on("messageCreate", (m) => { onMessage(m).catch((e) => console.error("matches onMessage:", e.message)); });

  console.log("matches: threads " + (CFG.matchThreads === false ? "OFF" : "ON") + ", map bans " + (bansEnabled() ? "ON" : "OFF"));
  return { onMatchReady, registerCommands, channelFor };
};
