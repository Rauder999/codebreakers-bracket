// ============================================================================
// Screenshot -> structured match result, via Claude vision + JSON schema.
//
// This module only TRANSCRIBES what is on screen. Mapping observed player
// names onto bracket teams happens in stats/rosters.js against the live
// tournament state -- keeping the two apart is what makes the extraction
// robust when a squad name on screen differs from the bracket team name.
//
// Layout of a THE FINALS results screen (see samples/ for real ones):
//   [placement badge] [squad crest / SQUAD NAME / $cash] [ one row per player ]
//   and each player row is:
//     M  [CLUB]  NAME#1234  (platform icon)  E  A  D  R  COMBAT  SUPPORT  OBJECTIVE
//
// Two traps that cost real accuracy if you skip them:
//   1. Squads are NOT listed in placement order. The viewing player's own
//      squad is pinned to the top, often above a "VS" divider. The number in
//      the far-left rail is the placement -- never the vertical position.
//   2. The class letter and the [CLUB] tag are not part of the player name.
// ============================================================================
const Anthropic = require("@anthropic-ai/sdk");

const STAT_COLUMN = (col, desc) => ({
  anyOf: [{ type: "string" }, { type: "null" }],
  description: `${col} column for this player row, transcribed exactly as shown (keep commas). ${desc} Null if unreadable or absent.`,
});

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["screen_type", "confidence", "map_name", "in_progress", "squads", "notes"],
  properties: {
    screen_type: {
      type: "string",
      enum: ["cashout_results", "final_round_results", "other"],
      description: "cashout_results = multi-squad standings; final_round_results = 2-squad result; other = not a THE FINALS result screen",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    map_name: { anyOf: [{ type: "string" }, { type: "null" }], description: "Map name visible on the screen, or null" },
    in_progress: { type: "boolean", description: "True if this looks like a mid-match scoreboard rather than a final result" },
    squads: {
      type: "array",
      description: "Every squad block on the screen, listed exactly once each",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["placement", "players"],
        properties: {
          placement: { type: "integer", description: "Read from the far-left rail badge of the block. 1 = winner." },
          squad_label: { anyOf: [{ type: "string" }, { type: "null" }], description: "Squad name shown on the block, if any" },
          cash: { anyOf: [{ type: "string" }, { type: "null" }], description: "Cash total shown for the squad, exactly as shown (e.g. \"$39,500\")" },
          players: {
            type: "array",
            description: "One entry per player row inside this squad block",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: {
                name: { type: "string", description: "Player name WITH its #tag and WITHOUT the class letter or [CLUB] tag, e.g. \"SHADOW#7360\"" },
                class: { anyOf: [{ type: "string", enum: ["L", "M", "H"] }, { type: "null" }], description: "Class letter at the start of the row: L (Light), M (Medium) or H (Heavy)" },
                eliminations: STAT_COLUMN("E", "Eliminations."),
                assists: STAT_COLUMN("A", "Assists."),
                deaths: STAT_COLUMN("D", "Deaths."),
                revives: STAT_COLUMN("R", "Revives."),
                combat: STAT_COLUMN("COMBAT", "Combat score, usually four digits."),
                support: STAT_COLUMN("SUPPORT", "Support score."),
                objective: STAT_COLUMN("OBJECTIVE", "Objective score."),
                disconnected: { anyOf: [{ type: "boolean" }, { type: "null" }], description: "True if the row is greyed out / marked as disconnected" },
              },
            },
          },
        },
      },
    },
    notes: { type: "string", description: "Anything suspicious, ambiguous or unreadable, one or two sentences" },
  },
};

function buildPrompt({ rosters, expectedTeams, scheduledMap, label }) {
  const rosterHint = (rosters || [])
    .map((r) => `- ${r.team}: ${r.names.length ? r.names.join(", ") : "roster unknown"}`)
    .join("\n");

  return [
    `This is a screenshot from the game THE FINALS showing a match result / standings screen.`,
    label ? `It should be the result of: ${label}${scheduledMap ? ` on map "${scheduledMap}"` : ""}.` : "",

    `Each squad is one coloured block. The number badge in the far-left rail of a block is that squad's PLACEMENT (1 = first place / winner). `
      + `IMPORTANT: squads are NOT always listed in placement order -- the viewing player's own squad is often pinned at the top, sometimes above a "VS" divider. `
      + `Always report the placement from the left-rail badge, never from vertical position. A higher cash total should track a better placement; use that as a sanity check if a badge is obscured by an overlay or cursor.`,

    `Each row inside a block is one player: a class letter (L, M or H), an optional [CLUB] tag in brackets, then the player name with its #number tag, then a platform icon, then the stat columns in this order: E, A, D, R, COMBAT, SUPPORT, OBJECTIVE. `
      + `For "name", transcribe ONLY the player name plus its #tag (e.g. "SHADOW#7360") -- exclude the class letter and the club tag. Record the class letter separately in "class". `
      + `Transcribe every stat column exactly as shown, keeping commas; use null for anything you genuinely cannot read. Do not guess a number to fill a gap. `
      + `Greyed-out rows are disconnected players: include them and set disconnected to true. List each squad exactly once -- a squad pinned at the top must not also be reported in its placement position.`,

    `Copy names exactly as displayed. Do not invent names you cannot read, and do not "correct" a name towards the roster below -- transcribe what is on screen.`,

    `Set screen_type to "other" and return an empty squads array if this is not a THE FINALS result/standings screen (a lobby, a mid-game HUD without standings, or an unrelated image).`,
    `If the match is clearly still in progress (round timer running, players mid-revive), still transcribe it but set in_progress to true and confidence to at most "medium".`,

    expectedTeams && expectedTeams.length
      ? `For reference only, the bracket expects these teams in this match: ${expectedTeams.join(" vs ")}. If the squads on screen clearly are not these teams, say so in notes and use low confidence.`
      : "",
    rosterHint ? `Rosters as registered (on-screen names may differ slightly):\n${rosterHint}` : "",
  ].filter(Boolean).join("\n\n");
}

// The server-side fallback beta rejects unknown combos on some accounts;
// degrade to a plain call rather than losing the result.
async function callClaude(anthropic, params) {
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

/**
 * @param {object} opts
 * @param {Anthropic} opts.anthropic  client
 * @param {string}    opts.model
 * @param {Buffer}    opts.buf        raw image bytes
 * @param {string}    opts.mediaType  image/png | image/jpeg | image/webp | image/gif
 * @param {Array}     opts.rosters    [{ team, names: [embarkId, ...] }]
 * @param {Array}     opts.expectedTeams bracket team names for this pod
 * @param {string}    opts.scheduledMap
 * @param {string}    opts.label      pod label
 * @returns {Promise<{verdict?: object, fail?: string}>}
 */
async function extract(opts) {
  const { anthropic, model, buf, mediaType } = opts;
  const resp = await callClaude(anthropic, {
    model: model || "claude-opus-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: RESULT_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } },
        { type: "text", text: buildPrompt(opts) },
      ],
    }],
  });

  if (resp.stop_reason === "refusal") return { fail: "analysis was declined" };
  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock) return { fail: "empty analysis" };
  let verdict;
  try { verdict = JSON.parse(textBlock.text); } catch { return { fail: "unparseable analysis" }; }
  if (verdict.screen_type === "other") return { fail: "does not look like a match results screen" };
  if (!Array.isArray(verdict.squads) || verdict.squads.length < 2) return { fail: "fewer than two squads readable" };
  return { verdict };
}

module.exports = { extract, buildPrompt, RESULT_SCHEMA };
