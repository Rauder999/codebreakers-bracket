// ============================================================================
// Screenshot result recognition \u2014 "bot proposes, moderator confirms".
//   1. A participant posts a scoreboard screenshot in the tournament channel.
//   2. We match the author to their active (ready, unplayed) match.
//   3. Claude vision extracts the ranking; we cross-check rosters and map.
//   4. A proposal embed with Apply/Reject buttons goes to the channel;
//      a moderator (Manage Server) clicks Apply -> worker applies placements,
//      the bracket propagates, and the match-ready pinger announces the next
//      match automatically.
// Anti-abuse: author must be a participant of the match, image sha256 dedupe,
// map cross-check, per-pod single pending proposal.
// ============================================================================
const crypto = require("crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");

const IMAGE_TYPES = { "image/png": 1, "image/jpeg": 1, "image/webp": 1, "image/gif": 1 };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_scoreboard", "confidence", "map_name", "ranking", "notes"],
  properties: {
    is_scoreboard: { type: "boolean", description: "True only if the image is a genuine end-of-match results/scoreboard screen" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    map_name: { anyOf: [{ type: "string" }, { type: "null" }], description: "Map name visible on the screen, or null" },
    ranking: {
      type: "array",
      description: "Teams from best placement to worst, using EXACTLY the provided team names",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["team", "evidence_players"],
        properties: {
          team: { type: "string" },
          evidence_players: { type: "array", items: { type: "string" }, description: "Player names visible on screen that matched this team's roster" },
        },
      },
    },
    notes: { type: "string", description: "Anything suspicious or ambiguous, one or two sentences" },
  },
};

module.exports = function setupResults(ctx) {
  const { client, sessions, CFG, ENV, WORKER, norm, mainGuild } = ctx;
  if (!ENV.ANTHROPIC_API_KEY) { console.log("results: ANTHROPIC_API_KEY missing \u2014 screenshot recognition disabled"); return; }
  if (!ENV.BOT_SECRET) { console.log("results: BOT_SECRET missing \u2014 screenshot recognition disabled"); return; }

  const anthropic = new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY });
  const pending = new Map();      // proposal message id -> {code, podId, placements, authorId}
  const pendingPods = new Set();  // podId with an open proposal
  const seenHashes = new Set();   // image sha256, session-lifetime

  const resultsChannelId = () => CFG.resultsChannelId || CFG.announceChannelId;

  // Fallbacks beta may reject unknown combos server-side; degrade gracefully.
  async function callClaude(params) {
    try {
      return await anthropic.beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (e) {
      if (e && e.status === 400) return anthropic.messages.create(params);
      throw e;
    }
  }

  function findAuthorMatch(username) {
    const uname = norm(username);
    for (const [code, entry] of sessions) {
      const s = entry.lastState;
      if (!s || !Array.isArray(s.pods)) continue;
      const myTeams = new Set();
      for (const seed of s.seeds || []) {
        if ((seed.discords || []).some((d) => norm(d) === uname)) myTeams.add(seed.name);
      }
      if (!myTeams.size) continue;
      for (const pod of s.pods) {
        const ready = pod.teams && pod.teams.length >= 2 && pod.teams.every((t) => t.name) && pod.teams.every((t) => !t.placement);
        if (ready && pod.teams.some((t) => myTeams.has(t.name))) return { code, state: s, pod };
      }
    }
    return null;
  }

  function rosterLine(s, teamName) {
    const seed = (s.seeds || []).find((sd) => sd.name === teamName);
    return `- ${teamName}: players [${(seed && seed.players || []).join(", ") || "unknown"}]`;
  }

  async function analyze(msg, att, found) {
    const { code, state: s, pod } = found;
    const res = await fetch(att.url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return { fail: "image too large" };
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (seenHashes.has(hash)) return { fail: "duplicate screenshot (already submitted)" };
    seenHashes.add(hash);

    const mediaType = (att.contentType || "").split(";")[0] || "image/png";
    const teams = pod.teams.map((t) => t.name);
    const prompt = [
      `You are verifying a competitive match result for the game THE FINALS.`,
      `Match: ${pod.label}${pod.map ? ` on map "${pod.map}"` : ""}.`,
      `Teams and rosters (Embark IDs):`,
      ...teams.map((t) => rosterLine(s, t)),
      ``,
      `Examine the screenshot. Decide whether it is a genuine end-of-match results/scoreboard screen (not a lobby, mid-game HUD, or unrelated image).`,
      `Match the player names visible on screen against the rosters above, and produce the final ranking best-to-worst using EXACTLY the team names given.`,
      `If player names don't clearly match the rosters, or the screen looks like a different match, say so in notes and use low confidence.`,
    ].join("\n");

    const resp = await callClaude({
      model: CFG.model || "claude-opus-5",
      max_tokens: 2048,
      output_config: { effort: "medium", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } },
          { type: "text", text: prompt },
        ],
      }],
    });
    if (resp.stop_reason === "refusal") return { fail: "analysis was declined" };
    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock) return { fail: "empty analysis" };
    let verdict;
    try { verdict = JSON.parse(textBlock.text); } catch { return { fail: "unparseable analysis" }; }
    return { verdict, hash };
  }

  function buildPlacements(pod, verdict) {
    const teams = pod.teams.map((t) => t.name);
    const ranked = (verdict.ranking || []).map((r) => r.team).filter((t) => teams.includes(t));
    if (!ranked.length) return null;
    const placements = {};
    ranked.forEach((t, i) => { placements[t] = i + 1; });
    // Two-team match with only the winner identified: the other team is 2nd.
    if (teams.length === 2 && ranked.length === 1) {
      placements[teams.find((t) => t !== ranked[0])] = 2;
    }
    // Every slot must be placed for the bracket to propagate cleanly.
    if (Object.keys(placements).length !== teams.length) return null;
    return placements;
  }

  async function onMessage(msg) {
    if (msg.author.bot || msg.channelId !== resultsChannelId()) return;
    const att = [...msg.attachments.values()].find((a) => IMAGE_TYPES[(a.contentType || "").split(";")[0]]);
    if (!att) return;

    const found = findAuthorMatch(msg.author.username);
    if (!found) { console.log(`results: screenshot from ${msg.author.username} \u2014 no active match, ignored`); return; }
    if (pendingPods.has(found.pod.id)) { await msg.react("\u23F3"); return; } // hourglass: already reviewing

    await msg.react("\uD83D\uDD0D"); // magnifying glass: analyzing
    const { verdict, fail } = await analyze(msg, att, found);
    if (fail || !verdict.is_scoreboard) {
      await msg.reply({ content: `Could not verify this screenshot${fail ? ` (${fail})` : " (does not look like a match results screen)"}. A moderator can enter the result manually.`, allowedMentions: { repliedUser: false } });
      return;
    }

    const placements = buildPlacements(found.pod, verdict);
    if (!placements) {
      await msg.reply({ content: `Could not confidently match the teams on this screenshot to **${found.pod.label}** (${verdict.notes || "no roster match"}). A moderator can enter the result manually.`, allowedMentions: { repliedUser: false } });
      return;
    }

    const DASH = "\u2014";
    const lines = Object.entries(placements).sort((a, b) => a[1] - b[1])
      .map(([team, place]) => `**${place}.** ${team}`);
    const mapMismatch = found.pod.map && verdict.map_name &&
      norm(verdict.map_name).replace(/[^a-z0-9]/g, "") !== norm(found.pod.map).replace(/[^a-z0-9]/g, "");
    const warnings = [];
    if (mapMismatch) warnings.push(`\u26A0\uFE0F Map on screen ("${verdict.map_name}") does not match the scheduled map ("${found.pod.map}")`);
    if (verdict.confidence !== "high") warnings.push(`\u26A0\uFE0F Confidence: ${verdict.confidence}`);

    const embed = {
      title: `\uD83D\uDCCB ${found.pod.label} ${DASH} result proposal`,
      description: [
        lines.join("\n"),
        "",
        verdict.notes ? `Notes: ${verdict.notes}` : null,
        warnings.length ? warnings.join("\n") : null,
        `Submitted by <@${msg.author.id}> \u00B7 session ${found.code}`,
      ].filter(Boolean).join("\n"),
      color: warnings.length ? 0xff8a3d : 0x28d17c,
      thumbnail: { url: att.url },
      footer: { text: "Waiting for a moderator to confirm" },
    };
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cbres:apply").setLabel("Apply result").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cbres:reject").setLabel("Reject").setStyle(ButtonStyle.Danger),
    );
    const proposal = await msg.reply({ embeds: [embed], components: [row], allowedMentions: { repliedUser: false } });
    pending.set(proposal.id, { code: found.code, podId: found.pod.id, placements, embed });
    pendingPods.add(found.pod.id);
    console.log(`results: proposal for ${found.pod.id} (${found.code}): ${JSON.stringify(placements)} [${verdict.confidence}]`);
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
        body: JSON.stringify({ code: entry.code, podId: entry.podId, placements: entry.placements, editor: `${i.user.username} (via bot)` }),
      });
      const data = await res.json();
      if (!data.ok) {
        await i.reply({ content: `Failed to apply: ${data.error || res.status}`, ephemeral: true });
        return;
      }
      const embed = { ...entry.embed, color: 0x28d17c, footer: { text: `\u2705 Applied by ${i.user.username}` } };
      await i.update({ embeds: [embed], components: [] });
    } else {
      const embed = { ...entry.embed, color: 0xff4d5e, footer: { text: `\u274C Rejected by ${i.user.username}` } };
      await i.update({ embeds: [embed], components: [] });
    }
    pending.delete(i.message.id);
    pendingPods.delete(entry.podId);
  }

  client.on("messageCreate", (m) => { onMessage(m).catch((e) => console.error("results onMessage:", e.message)); });
  client.on("interactionCreate", (i) => { onButton(i).catch((e) => console.error("results onButton:", e.message)); });
  console.log("results: screenshot recognition armed (model " + (CFG.model || "claude-opus-5") + ")");
};
