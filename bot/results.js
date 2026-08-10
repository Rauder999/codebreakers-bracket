// ============================================================================
// Screenshot result recognition \u2014 "bot proposes, moderator confirms".
//   1. A participant posts a scoreboard screenshot in the tournament channel.
//   2. We match the author to their active (ready, unplayed) match.
//   3. Claude vision transcribes every squad and every player row; we
//      reconcile those against the registered rosters (stats/rosters.js).
//   4. A proposal embed with Apply/Reject buttons goes to the channel;
//      a moderator (Manage Server) clicks Apply -> worker applies placements,
//      the bracket propagates, the match-ready pinger announces the next
//      match, and the full per-player stat line is committed to the stats DB.
// Anti-abuse: author must be a participant of the match, image sha256 dedupe,
// map cross-check, per-pod single pending proposal.
//
// Unicode is written as \uXXXX escapes on purpose: these files travel to the
// VM through pipes that have mangled raw UTF-8 before.
// ============================================================================
const crypto = require("crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");

const vision = require("./stats/vision");
const { podRosters, derivePlacements, rosterHints } = require("./stats/rosters");

// The stats store is optional: if better-sqlite3 is not built on this host we
// still want match results to apply. Pings and results matter more than stats.
let ingest = null;
try { ingest = require("./stats/ingest"); }
catch (e) { console.error("stats: store unavailable, results will not be recorded:", e.message); }

const IMAGE_TYPES = { "image/png": 1, "image/jpeg": 1, "image/webp": 1, "image/gif": 1 };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Returned when the module cannot run, so callers never branch on undefined.
const DISABLED = {
  disabled: true,
  submit: async () => ({ fail: "result recognition is not configured on this host" }),
  findMatchForUser: () => null,
};

module.exports = function setupResults(ctx) {
  const { client, sessions, CFG, ENV, WORKER, norm } = ctx;
  if (!ENV.ANTHROPIC_API_KEY) { console.log("results: ANTHROPIC_API_KEY missing \u2014 screenshot recognition disabled"); return DISABLED; }
  if (!ENV.BOT_SECRET) { console.log("results: BOT_SECRET missing \u2014 screenshot recognition disabled"); return DISABLED; }

  const anthropic = new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY });
  const pending = new Map();      // proposal message id -> full proposal context
  const pendingPods = new Set();  // podId with an open proposal
  const seenHashes = new Set();   // image sha256, session-lifetime

  const resultsChannelId = () => CFG.resultsChannelId || CFG.announceChannelId;

  function findAuthorMatch(username) {
    const uname = norm(username);
    for (const [code, entry] of sessions) {
      const s = entry.lastState;
      if (!s || !Array.isArray(s.pods)) continue;
      const myTeams = new Set();
      for (const seed of s.seeds || []) {
        // Discords may be one comma-joined string per team - expand first.
        const list = (seed.discords || []).flatMap((d) => String(d).split(","));
        if (list.some((d) => norm(d) === uname)) myTeams.add(seed.name);
      }
      if (!myTeams.size) continue;
      for (const pod of s.pods) {
        const ready = pod.teams && pod.teams.length >= 2 && pod.teams.every((t) => t.name) && pod.teams.every((t) => !t.placement);
        if (ready && pod.teams.some((t) => myTeams.has(t.name))) return { code, state: s, pod };
      }
    }
    return null;
  }

  async function analyze(att, found) {
    const { state: s, pod } = found;
    const res = await fetch(att.url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return { fail: "image too large" };
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (seenHashes.has(hash)) return { fail: "duplicate screenshot (already submitted)" };
    seenHashes.add(hash);

    const rosters = podRosters(s, pod);
    const out = await vision.extract({
      anthropic,
      model: CFG.model || "claude-opus-5",
      buf,
      mediaType: (att.contentType || "").split(";")[0] || "image/png",
      rosters: rosterHints(rosters),
      expectedTeams: pod.teams.map((t) => t.name),
      scheduledMap: pod.map || null,
      label: pod.label || null,
    });
    if (out.fail) return { fail: out.fail };
    return { verdict: out.verdict, hash, rosters };
  }

  // Compact stat preview so a moderator can eyeball the numbers before Apply.
  function statLines(assignments, placements) {
    const DOT = "\u00B7", DASH = "\u2014";
    return assignments
      .filter((a) => a.team)
      .sort((x, y) => (placements[x.team] || 99) - (placements[y.team] || 99))
      .map((a) => {
        const cash = a.squad.cash ? ` ${DOT} ${a.squad.cash}` : "";
        const rows = (a.squad.players || []).map((p) => {
          const kda = [p.eliminations, p.assists, p.deaths].map((v) => (v == null ? "?" : v)).join("/");
          const cls = p.class ? `[${p.class}] ` : "";
          return ` ${cls}${p.name} ${DASH} ${kda}${p.revives != null ? ` ${DOT} ${p.revives}R` : ""}`;
        });
        return [`**${placements[a.team]}.** ${a.team}${cash}`, ...rows].join("\n");
      })
      .join("\n");
  }

  // Called only from an explicit submission (Submit button or /result), never
  // from arbitrary images: see matches.js. Returns {ok} or {fail: reason}.
  async function submit({ att, found, user, channel }) {
    if (pendingPods.has(found.pod.id)) return { fail: "a result for this match is already waiting for a moderator" };

    const { verdict, hash, rosters, fail } = await analyze(att, found);
    if (fail) return { fail };

    const { placements, assignments, problems } = derivePlacements(verdict.squads, rosters);
    if (!placements) {
      return { fail: `could not match the squads on screen to **${found.pod.label}** (${problems.join("; ") || verdict.notes || "no roster match"})` };
    }

    const DASH = "\u2014", WARN = "\u26A0\uFE0F", INFO = "\u2139\uFE0F";
    const mapMismatch = found.pod.map && verdict.map_name &&
      norm(verdict.map_name).replace(/[^a-z0-9]/g, "") !== norm(found.pod.map).replace(/[^a-z0-9]/g, "");
    const warnings = [];
    if (mapMismatch) warnings.push(`${WARN} Map on screen ("${verdict.map_name}") does not match the scheduled map ("${found.pod.map}")`);
    if (verdict.in_progress) warnings.push(`${WARN} Screenshot looks like a match still in progress`);
    if (verdict.confidence !== "high") warnings.push(`${WARN} Confidence: ${verdict.confidence}`);
    for (const p of problems) warnings.push(`${WARN} ${p}`);
    // Squads on screen that are not in this bracket match: normal when the
    // match shared a lobby, but worth surfacing.
    const outsiders = assignments.filter((a) => !a.team).length;
    if (outsiders) warnings.push(`${INFO} ${outsiders} squad(s) on screen are not in this match; placements were taken from the relative order of the tournament teams`);

    // Team confirmation: ONE player from EACH team presses Accept. If not all
    // teams confirm within 60 seconds, the result auto-applies. A Dispute
    // button stays on the applied message and pings the admins.
    const teamRosters = {};
    for (const t of found.pod.teams) {
      const seed = (found.state.seeds || []).find((sd) => sd.name === t.name);
      teamRosters[t.name] = ((seed && seed.discords) || [])
        .flatMap((x) => String(x).split(","))
        .map(norm)
        .filter(Boolean);
    }
    const confirmableTeams = Object.keys(teamRosters).filter((t) => teamRosters[t].length);
    const confirmSec = Number(CFG.resultConfirmSec) > 0 ? Number(CFG.resultConfirmSec) : 60;
    const confirmLine = confirmableTeams.length
      ? `One player from **each team**: press **Accept result** to confirm. If not everyone confirms, the result auto-applies in ${confirmSec}s. An admin click applies it instantly.`
      : `Auto-applying in ${confirmSec}s (no registered players found) \u2014 an admin click applies it instantly.`;

    const embed = {
      title: `\uD83D\uDCCB ${found.pod.label} ${DASH} result`,
      description: [
        statLines(assignments, placements),
        "",
        verdict.notes ? `Notes: ${verdict.notes}` : null,
        warnings.length ? warnings.join("\n") : null,
        confirmLine,
        `Submitted by <@${user.id}> \u00B7 session ${found.code}`,
      ].filter(Boolean).join("\n").slice(0, 4000),
      color: warnings.length ? 0xff8a3d : 0x28d17c,
      thumbnail: { url: att.url },
      footer: { text: confirmableTeams.length ? `Teams confirmed: 0/${confirmableTeams.length} \u00B7 auto-apply in ${confirmSec}s` : `Auto-apply in ${confirmSec}s` },
    };
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cbres:apply").setLabel("Accept result").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cbres:reject").setLabel("Reject (admin)").setStyle(ButtonStyle.Danger),
    );
    const proposal = await channel.send({ embeds: [embed], components: [row] });
    const entry = {
      code: found.code, state: found.state, pod: found.pod,
      placements, assignments, verdict, embed,
      sha256: hash, screenshotUrl: att.url, submittedBy: user.username,
      teamRosters, confirmableTeams, confirmedTeams: [],
      channelId: proposal.channelId, messageId: proposal.id, timer: null,
    };
    entry.timer = setTimeout(() => {
      applyResult(entry, "auto-confirmation (timeout)", null)
        .catch((e) => console.error("results auto-apply:", e.message));
    }, confirmSec * 1000);
    pending.set(proposal.id, entry);
    pendingPods.add(found.pod.id);
    console.log(`results: proposal for ${found.pod.id} (${found.code}): ${JSON.stringify(placements)} [${verdict.confidence}] teams=${confirmableTeams.length} autoApply=${confirmSec}s`);
    return { ok: true, message: proposal };
  }

  // Applied results kept around so the Dispute button works after apply.
  const applied = new Map(); // message id -> { code, podId, label, disputed }

  // Push the accepted result into the bracket and commit stats. `i` is the
  // triggering interaction, or null when the auto-confirm timer fires.
  async function applyResult(entry, appliedBy, i) {
    if (!pending.has(entry.messageId)) return false; // already applied/rejected
    const res = await fetch(`${WORKER}/bot/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bot-Secret": ENV.BOT_SECRET },
      body: JSON.stringify({ code: entry.code, podId: entry.pod.id, placements: entry.placements, editor: `${appliedBy} (via bot)` }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`results: apply failed for ${entry.pod.id}: ${data.error || res.status}`);
      if (i) await i.reply({ content: `Failed to apply: ${data.error || res.status}`, ephemeral: true });
      return false;
    }

    // Stats are recorded only once the bracket has accepted the result. A
    // failure here must never look like the result itself failed.
    let statsNote = "";
    if (ingest) {
      try {
        const out = ingest.commitMatch({
          code: entry.code, state: entry.state, pod: entry.pod,
          verdict: entry.verdict, assignments: entry.assignments, placements: entry.placements,
          appliedBy, submittedBy: entry.submittedBy,
          sha256: entry.sha256, screenshotUrl: entry.screenshotUrl,
        });
        statsNote = ` \u00B7 ${out.players} player stat lines recorded`;
        console.log(`stats: committed match ${out.matchId} (${entry.code}/${entry.pod.id}): ${out.teams} teams, ${out.players} players`);
      } catch (e) {
        statsNote = " \u00B7 stats NOT recorded (see logs)";
        console.error("stats: commit failed:", e.message);
      }
    }

    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    const embed = { ...entry.embed, color: 0x28d17c, footer: { text: `\u2705 Confirmed by ${appliedBy}${statsNote}` } };
    const disputeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cbres:dispute").setLabel("Dispute").setStyle(ButtonStyle.Secondary),
    );
    const payload = { embeds: [embed], components: [disputeRow] };
    if (i) {
      await i.update(payload);
    } else {
      try {
        const ch = await client.channels.fetch(entry.channelId);
        const msg = await ch.messages.fetch(entry.messageId);
        await msg.edit(payload);
      } catch (e) { console.error("results: message edit after auto-apply failed:", e.message); }
    }
    applied.set(entry.messageId, { code: entry.code, podId: entry.pod.id, label: entry.pod.label, disputed: false });
    pending.delete(entry.messageId);
    pendingPods.delete(entry.pod.id);
    return true;
  }

  const adminIds = () => CFG.adminDiscordIds || (CFG.stats && CFG.stats.adminDiscordIds) || [];

  async function onDispute(i) {
    const info = applied.get(i.message.id);
    if (!info) { await i.reply({ content: "This result is no longer tracked (bot restarted). Ping a moderator directly.", ephemeral: true }); return; }
    const pings = adminIds().map((id) => `<@${id}>`).join(" ");
    await i.reply({
      content: `\u26A0\uFE0F ${pings || "Moderators:"} the result of **${info.label}** is disputed by <@${i.user.id}>. Please review.`,
      allowedMentions: { users: [...adminIds(), i.user.id] },
    });
    if (!info.disputed) {
      info.disputed = true;
      try {
        const embed = { ...(i.message.embeds[0] ? i.message.embeds[0].toJSON() : {}), color: 0xff8a3d, footer: { text: `\u26A0\uFE0F Disputed by ${i.user.username}` } };
        await i.message.edit({ embeds: [embed], components: [] });
      } catch (e) { console.error("results: dispute edit failed:", e.message); }
    }
  }

  async function onButton(i) {
    if (!i.isButton() || !i.customId.startsWith("cbres:")) return;
    if (i.customId === "cbres:dispute") { await onDispute(i); return; }
    const entry = pending.get(i.message.id);
    if (!entry) { await i.reply({ content: "This proposal has expired (bot restarted). Ask for a re-submit.", ephemeral: true }); return; }
    const isAdmin = i.member && i.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const uname = norm(i.user.username);
    const myTeam = (entry.confirmableTeams || []).find((t) => entry.teamRosters[t].includes(uname)) || null;

    if (i.customId === "cbres:reject") {
      if (!isAdmin) {
        await i.reply({ content: "Only admins can reject. If this result is wrong, press nothing and ping a moderator.", ephemeral: true });
        return;
      }
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      const embed = { ...entry.embed, color: 0xff4d5e, footer: { text: `\u274C Rejected by ${i.user.username}` } };
      await i.update({ embeds: [embed], components: [] });
      pending.delete(i.message.id);
      pendingPods.delete(entry.pod.id);
      return;
    }

    // Accept: an admin click applies instantly; otherwise one player from each
    // team. The 60s timer applies it anyway if teams are slow.
    if (isAdmin) {
      await applyResult(entry, `admin ${i.user.username}`, i);
      return;
    }
    if (!myTeam) {
      await i.reply({ content: "Only players of this match (or an admin) can confirm its result.", ephemeral: true });
      return;
    }
    if (entry.confirmedTeams.includes(myTeam)) {
      await i.reply({ content: `**${myTeam}** has already confirmed.`, ephemeral: true });
      return;
    }
    entry.confirmedTeams.push(myTeam);
    if (entry.confirmedTeams.length >= entry.confirmableTeams.length) {
      await applyResult(entry, `all teams (${entry.confirmedTeams.length}/${entry.confirmableTeams.length})`, i);
      return;
    }
    const embed = { ...entry.embed, footer: { text: `Teams confirmed: ${entry.confirmedTeams.length}/${entry.confirmableTeams.length} (${entry.confirmedTeams.join(", ")}) \u00B7 auto-apply pending` } };
    entry.embed = embed;
    await i.update({ embeds: [embed] });
  }

  client.on("interactionCreate", (i) => { onButton(i).catch((e) => console.error("results onButton:", e.message)); });
  console.log("results: screenshot recognition armed (model " + (CFG.model || "claude-opus-5") + (ingest ? ", stats store ready" : ", stats store OFF") + ")");

  // Submissions are driven by matches.js (Submit button / /result command).
  return { submit, findMatchForUser: findAuthorMatch };
};
