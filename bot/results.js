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

    const embed = {
      title: `\uD83D\uDCCB ${found.pod.label} ${DASH} result proposal`,
      description: [
        statLines(assignments, placements),
        "",
        verdict.notes ? `Notes: ${verdict.notes}` : null,
        warnings.length ? warnings.join("\n") : null,
        `Submitted by <@${user.id}> \u00B7 session ${found.code}`,
      ].filter(Boolean).join("\n").slice(0, 4000),
      color: warnings.length ? 0xff8a3d : 0x28d17c,
      thumbnail: { url: att.url },
      footer: { text: "Waiting for a moderator to confirm" },
    };
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cbres:apply").setLabel("Apply result").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cbres:reject").setLabel("Reject").setStyle(ButtonStyle.Danger),
    );
    const proposal = await channel.send({ embeds: [embed], components: [row] });
    pending.set(proposal.id, {
      code: found.code, state: found.state, pod: found.pod,
      placements, assignments, verdict, embed,
      sha256: hash, screenshotUrl: att.url, submittedBy: user.username,
    });
    pendingPods.add(found.pod.id);
    console.log(`results: proposal for ${found.pod.id} (${found.code}): ${JSON.stringify(placements)} [${verdict.confidence}]`);
    return { ok: true, message: proposal };
  }

  async function onButton(i) {
    if (!i.isButton() || !i.customId.startsWith("cbres:")) return;
    const entry = pending.get(i.message.id);
    if (!entry) { await i.reply({ content: "This proposal has expired (bot restarted). Ask for a re-submit.", ephemeral: true }); return; }
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply({ content: "Only moderators can confirm results.", ephemeral: true });
      return;
    }
    if (i.customId === "cbres:apply") {
      const res = await fetch(`${WORKER}/bot/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bot-Secret": ENV.BOT_SECRET },
        body: JSON.stringify({ code: entry.code, podId: entry.pod.id, placements: entry.placements, editor: `${i.user.username} (via bot)` }),
      });
      const data = await res.json();
      if (!data.ok) {
        await i.reply({ content: `Failed to apply: ${data.error || res.status}`, ephemeral: true });
        return;
      }

      // Stats are recorded only once the bracket has accepted the result. A
      // failure here must never look like the result itself failed.
      let statsNote = "";
      if (ingest) {
        try {
          const out = ingest.commitMatch({
            code: entry.code, state: entry.state, pod: entry.pod,
            verdict: entry.verdict, assignments: entry.assignments, placements: entry.placements,
            appliedBy: i.user.username, submittedBy: entry.submittedBy,
            sha256: entry.sha256, screenshotUrl: entry.screenshotUrl,
          });
          statsNote = ` \u00B7 ${out.players} player stat lines recorded`;
          console.log(`stats: committed match ${out.matchId} (${entry.code}/${entry.pod.id}): ${out.teams} teams, ${out.players} players`);
        } catch (e) {
          statsNote = " \u00B7 stats NOT recorded (see logs)";
          console.error("stats: commit failed:", e.message);
        }
      }

      const embed = { ...entry.embed, color: 0x28d17c, footer: { text: `\u2705 Applied by ${i.user.username}${statsNote}` } };
      await i.update({ embeds: [embed], components: [] });
    } else {
      const embed = { ...entry.embed, color: 0xff4d5e, footer: { text: `\u274C Rejected by ${i.user.username}` } };
      await i.update({ embeds: [embed], components: [] });
    }
    pending.delete(i.message.id);
    pendingPods.delete(entry.pod.id);
  }

  client.on("interactionCreate", (i) => { onButton(i).catch((e) => console.error("results onButton:", e.message)); });
  console.log("results: screenshot recognition armed (model " + (CFG.model || "claude-opus-5") + (ingest ? ", stats store ready" : ", stats store OFF") + ")");

  // Submissions are driven by matches.js (Submit button / /result command).
  return { submit, findMatchForUser: findAuthorMatch };
};
