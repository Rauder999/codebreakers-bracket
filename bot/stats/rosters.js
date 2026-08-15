// ============================================================================
// Bracket <-> scoreboard reconciliation.
//
// The vision pass transcribes squads as they appear on screen. This module
// decides which of those squads is which bracket team, using the registered
// rosters as evidence, and derives the placements the worker will apply.
//
// Why this is not a simple name compare:
//   * The squad name on screen is the in-game club/squad name, which is often
//     not the bracket team name at all.
//   * A tournament match may be played inside a lobby that also contains
//     squads with nothing to do with the bracket. Only the RELATIVE order of
//     the squads we recognise is meaningful.
//   * Embark IDs must be compared including their #tag. Two players can share
//     a base name; the bot's norm() would silently merge them.
// ============================================================================
const { embarkKey, baseKey, teamKey } = require("./db");

// Rosters for the teams in a pod, straight off the live bracket state.
function podRosters(state, pod) {
  return pod.teams.map((t) => {
    const seed = (state.seeds || []).find((sd) => sd.name === t.name);
    return {
      team: t.name,
      names: (seed && seed.players || []).filter(Boolean),
      discords: (seed && seed.discords || []).filter(Boolean),
    };
  });
}

// How strongly one transcribed squad looks like one bracket team.
//   exact Embark ID (with #tag) .... 10
//   unambiguous base-name match ....  4  (roster written without the tag)
//   squad label equals team name ...  3  (nice signal, never sufficient alone)
function scoreSquad(squad, roster) {
  const rosterExact = new Set(roster.names.map(embarkKey));
  const rosterBase = new Map();
  for (const n of roster.names) {
    const b = baseKey(n);
    rosterBase.set(b, (rosterBase.get(b) || 0) + 1);
  }

  let score = 0;
  const matched = [];
  for (const p of squad.players || []) {
    const key = embarkKey(p.name);
    if (!key) continue;
    if (rosterExact.has(key)) { score += 10; matched.push(p.name); continue; }
    const b = baseKey(p.name);
    // Only trust an untagged match when the roster has exactly one such name.
    if (rosterBase.get(b) === 1) { score += 4; matched.push(p.name); }
  }
  if (squad.squad_label && teamKey(squad.squad_label) === teamKey(roster.team)) score += 3;
  return { score, matched };
}

/**
 * Assign transcribed squads to bracket teams, greedily by strongest evidence.
 * Returns one entry per squad, in the order the vision pass reported them.
 *   { squad, team|null, score, matched[] }
 */
function assignSquads(squads, rosters) {
  const pairs = [];
  squads.forEach((squad, si) => {
    rosters.forEach((roster, ri) => {
      const { score, matched } = scoreSquad(squad, roster);
      if (score > 0) pairs.push({ si, ri, score, matched });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const squadTaken = new Set();
  const teamTaken = new Set();
  const bySquad = new Map();
  for (const p of pairs) {
    if (squadTaken.has(p.si) || teamTaken.has(p.ri)) continue;
    squadTaken.add(p.si);
    teamTaken.add(p.ri);
    bySquad.set(p.si, p);
  }

  return squads.map((squad, si) => {
    const hit = bySquad.get(si);
    return {
      squad,
      team: hit ? rosters[hit.ri].team : null,
      score: hit ? hit.score : 0,
      matched: hit ? hit.matched : [],
    };
  });
}

/**
 * Derive the placements to send to the worker.
 *
 * Only the squads we recognised count, and only their ORDER counts: a two-team
 * bracket match played inside a four-squad lobby where our teams finished 2nd
 * and 3rd is a 1-2 result for the bracket.
 *
 * Returns { placements, assignments, problems[] }. placements is null when the
 * result cannot be applied safely, with the reason in problems.
 */
function derivePlacements(squads, rosters) {
  const assignments = assignSquads(squads, rosters);
  const problems = [];

  const recognised = assignments.filter((a) => a.team);
  const wanted = rosters.map((r) => r.team);
  const missing = wanted.filter((t) => !recognised.some((a) => a.team === t));
  if (missing.length) {
    problems.push(`could not find ${missing.length === 1 ? "team" : "teams"} on the screenshot: ${missing.join(", ")}`);
    return { placements: null, assignments, problems };
  }

  // Weak evidence: a team identified by a single untagged name and nothing
  // else is a coin flip, not a result.
  for (const a of recognised) {
    if (a.score < 10) problems.push(`weak roster evidence for ${a.team} (matched: ${a.matched.join(", ") || "none"})`);
  }

  const ordered = [...recognised].sort((a, b) => a.squad.placement - b.squad.placement);
  const seen = new Set(ordered.map((a) => a.squad.placement));
  if (seen.size !== ordered.length) {
    problems.push("two recognised squads share the same placement badge");
    return { placements: null, assignments, problems };
  }

  const placements = {};
  ordered.forEach((a, i) => { placements[a.team] = i + 1; });
  return { placements, assignments, problems };
}

// Prompt hint: what the bracket thinks the rosters are.
const rosterHints = (rosters) => rosters.map((r) => ({ team: r.team, names: r.names }));

module.exports = { podRosters, assignSquads, derivePlacements, rosterHints, scoreSquad };
