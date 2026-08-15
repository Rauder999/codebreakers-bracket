// ============================================================================
// CodeBreakers stats store.
//   SQLite (better-sqlite3) in WAL mode so the bot process (writer) and the
//   cb-stats-web process (reader) can share one file safely.
//   Schema is idempotent: this module is safe to require from both.
//
// Design notes worth knowing before you change anything here:
//   * KD, averages and every other ratio are NEVER stored. They are computed
//     at query time from sums, so a moderator correcting one bad OCR read
//     fixes every derived number at once.
//   * Player identity is the Embark ID *including* its #tag. SHADOW#7360 and
//     SHADOW#1111 are different people. Do not reuse the bot's norm() here --
//     it strips #discriminator, which is right for Discord and catastrophic
//     for Embark IDs. Use embarkKey() below.
//   * match_players is UNIQUE on (match_id, name_key), not player_id, because
//     player_id is nullable for players we could not match to a roster and
//     SQLite lets NULLs collide freely in a unique index.
// ============================================================================
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.CB_STATS_DB || path.join(__dirname, "..", "data", "stats.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

// --- key normalizers --------------------------------------------------------

// Embark ID: keep the #tag, it is part of the identity. Strip a leading club
// tag in brackets and any stray whitespace the OCR may have introduced.
const embarkKey = (s) =>
  String(s || "")
    .trim()
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

// Everything before the #tag. Used only as a fallback when a roster entry was
// written without its tag, and only when the base name is unambiguous.
const baseKey = (s) => embarkKey(s).split("#")[0];

// Team / squad names: punctuation and spacing vary between the bracket and the
// scoreboard ("THE BIG SPLASH" vs "The Big Splash").
const teamKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// "3,270" -> 3270, "$39,500" -> 39500, "" / null / "-" -> null.
function toInt(v) {
  if (v === null || v === undefined) return null;
  const cleaned = String(v).replace(/[^0-9-]/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

const now = () => Date.now();

// --- schema -----------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    code          TEXT PRIMARY KEY,
    name          TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_code TEXT NOT NULL REFERENCES tournaments(code) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    name_key        TEXT NOT NULL,
    UNIQUE (tournament_code, name_key)
  );

  -- One row per human, across every tournament they ever play.
  CREATE TABLE IF NOT EXISTS players (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    embark_id        TEXT NOT NULL,
    embark_key       TEXT NOT NULL UNIQUE,
    base_key         TEXT NOT NULL,
    discord_username TEXT,
    first_seen_at    INTEGER NOT NULL,
    last_seen_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS players_base_idx ON players(base_key);

  CREATE TABLE IF NOT EXISTS team_members (
    team_id          INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    discord_username TEXT,
    is_sub           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_code   TEXT NOT NULL REFERENCES tournaments(code) ON DELETE CASCADE,
    pod_id            TEXT NOT NULL,
    label             TEXT,
    map_scheduled     TEXT,
    map_observed      TEXT,
    on_stream         INTEGER NOT NULL DEFAULT 0,
    played_at         INTEGER,
    applied_by        TEXT,
    submitted_by      TEXT,
    screenshot_sha256 TEXT,
    screenshot_url    TEXT,
    confidence        TEXT,
    notes             TEXT,
    raw_extraction    TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (tournament_code, pod_id)
  );
  CREATE INDEX IF NOT EXISTS matches_played_idx ON matches(played_at);

  -- placement          = placement within the bracket match (1..n over the
  --                      teams we recognised), which is what the worker applies
  -- placement_observed = the raw left-rail badge from the screenshot, which
  --                      differs whenever the match shared a lobby with squads
  --                      that are not in the tournament
  CREATE TABLE IF NOT EXISTS match_teams (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id           INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    team_id            INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    squad_label        TEXT,
    placement          INTEGER,
    placement_observed INTEGER,
    cash               INTEGER,
    slot               INTEGER NOT NULL,
    UNIQUE (match_id, slot)
  );
  CREATE INDEX IF NOT EXISTS match_teams_team_idx ON match_teams(team_id);

  -- The core table. One row per player per match.
  CREATE TABLE IF NOT EXISTS match_players (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    match_team_id INTEGER NOT NULL REFERENCES match_teams(id) ON DELETE CASCADE,
    player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
    name_observed TEXT NOT NULL,
    name_key      TEXT NOT NULL,
    class         TEXT,
    eliminations  INTEGER,
    assists       INTEGER,
    deaths        INTEGER,
    revives       INTEGER,
    combat        INTEGER,
    support       INTEGER,
    objective     INTEGER,
    disconnected  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (match_id, name_key)
  );
  CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players(player_id);
  CREATE INDEX IF NOT EXISTS match_players_team_idx   ON match_players(match_team_id);

  -- Moderator corrections. Keyed by match_id + name_key as well as the row id
  -- so the history survives a re-ingest that replaces the rows.
  CREATE TABLE IF NOT EXISTS stat_edits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        INTEGER NOT NULL,
    name_key        TEXT,
    match_player_id INTEGER,
    field           TEXT NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    edited_by       TEXT NOT NULL,
    edited_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS stat_edits_match_idx ON stat_edits(match_id);

  -- Site moderators, granted by the owners on the Users page of cb-stats-web.
  -- The admin role is resolved from this table on every request, so a grant
  -- or revoke takes effect on the person's next click with no re-login.
  -- Config stats.adminDiscordIds are the owners: implicitly moderators with
  -- no row here, and the only people who can grant or revoke.
  CREATE TABLE IF NOT EXISTS moderators (
    discord_id TEXT PRIMARY KEY,
    username   TEXT,
    added_by   TEXT,
    added_at   INTEGER NOT NULL
  );

  -- Web service identity (Discord OAuth).
  CREATE TABLE IF NOT EXISTS users (
    discord_id    TEXT PRIMARY KEY,
    username      TEXT,
    global_name   TEXT,
    avatar        TEXT,
    role          TEXT NOT NULL DEFAULT 'viewer',
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
`);

// --- views ------------------------------------------------------------------
// Flattened per-player-per-match row, the base of every aggregate below.
db.exec(`
  DROP VIEW IF EXISTS v_player_match;
  CREATE VIEW v_player_match AS
    SELECT
      mp.id            AS match_player_id,
      mp.player_id     AS player_id,
      mp.name_observed AS name_observed,
      mp.name_key      AS name_key,
      mp.class         AS class,
      mp.eliminations, mp.assists, mp.deaths, mp.revives,
      mp.combat, mp.support, mp.objective, mp.disconnected,
      m.id             AS match_id,
      m.tournament_code,
      m.pod_id, m.label, m.played_at,
      COALESCE(m.map_observed, m.map_scheduled) AS map,
      mt.id            AS match_team_id,
      mt.team_id       AS team_id,
      mt.squad_label, mt.placement, mt.cash AS team_cash
    FROM match_players mp
    JOIN matches     m  ON m.id  = mp.match_id
    JOIN match_teams mt ON mt.id = mp.match_team_id;

  DROP VIEW IF EXISTS v_player_totals;
  CREATE VIEW v_player_totals AS
    SELECT
      p.id AS player_id, p.embark_id, p.discord_username,
      COUNT(*)                       AS matches,
      SUM(vpm.eliminations)          AS eliminations,
      SUM(vpm.assists)               AS assists,
      SUM(vpm.deaths)                AS deaths,
      SUM(vpm.revives)               AS revives,
      SUM(vpm.combat)                AS combat,
      SUM(vpm.support)               AS support,
      SUM(vpm.objective)             AS objective,
      SUM(CASE WHEN vpm.placement = 1 THEN 1 ELSE 0 END) AS wins,
      AVG(CAST(vpm.placement AS REAL))                   AS avg_placement,
      -- deaths = 0 is a real result, not a divide-by-zero: fall back to elims.
      CASE WHEN SUM(vpm.deaths) > 0
           THEN CAST(SUM(vpm.eliminations) AS REAL) / SUM(vpm.deaths)
           ELSE CAST(SUM(vpm.eliminations) AS REAL) END  AS kd
    FROM v_player_match vpm
    JOIN players p ON p.id = vpm.player_id
    GROUP BY p.id;

  DROP VIEW IF EXISTS v_team_totals;
  CREATE VIEW v_team_totals AS
    SELECT
      t.id AS team_id, t.tournament_code, t.name,
      COUNT(DISTINCT mt.match_id)    AS matches,
      SUM(mt.cash)                   AS cash,
      AVG(CAST(mt.placement AS REAL)) AS avg_placement,
      SUM(CASE WHEN mt.placement = 1 THEN 1 ELSE 0 END) AS wins
    FROM teams t
    JOIN match_teams mt ON mt.team_id = t.id
    GROUP BY t.id;
`);

// --- small upserts ----------------------------------------------------------

const stmts = {
  upsertTournament: db.prepare(`
    INSERT INTO tournaments (code, name, first_seen_at, last_seen_at)
    VALUES (@code, @name, @ts, @ts)
    ON CONFLICT(code) DO UPDATE SET
      name = COALESCE(excluded.name, tournaments.name),
      last_seen_at = excluded.last_seen_at
  `),
  selTeam: db.prepare(`SELECT * FROM teams WHERE tournament_code = ? AND name_key = ?`),
  insTeam: db.prepare(`INSERT INTO teams (tournament_code, name, name_key) VALUES (?, ?, ?)`),
  selPlayerByKey: db.prepare(`SELECT * FROM players WHERE embark_key = ?`),
  selPlayerByBase: db.prepare(`SELECT * FROM players WHERE base_key = ?`),
  insPlayer: db.prepare(`
    INSERT INTO players (embark_id, embark_key, base_key, discord_username, first_seen_at, last_seen_at)
    VALUES (@embark_id, @embark_key, @base_key, @discord_username, @ts, @ts)
  `),
  touchPlayer: db.prepare(`
    UPDATE players SET last_seen_at = @ts,
      discord_username = COALESCE(@discord_username, discord_username)
    WHERE id = @id
  `),
  upsertMember: db.prepare(`
    INSERT INTO team_members (team_id, player_id, discord_username, is_sub)
    VALUES (@team_id, @player_id, @discord_username, @is_sub)
    ON CONFLICT(team_id, player_id) DO UPDATE SET
      discord_username = COALESCE(excluded.discord_username, team_members.discord_username)
  `),
  // Re-adding an existing moderator refreshes the username only: added_by and
  // added_at are the audit trail of the original grant and must survive.
  addModerator: db.prepare(`
    INSERT INTO moderators (discord_id, username, added_by, added_at)
    VALUES (@discord_id, @username, @added_by, @ts)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = COALESCE(excluded.username, moderators.username)
  `),
  delModerator: db.prepare(`DELETE FROM moderators WHERE discord_id = ?`),
  selModerator: db.prepare(`SELECT 1 FROM moderators WHERE discord_id = ?`),
  allModerators: db.prepare(`SELECT * FROM moderators ORDER BY added_at`),
};

function upsertTournament(code, name) {
  stmts.upsertTournament.run({ code, name: name || null, ts: now() });
  return code;
}

function upsertTeam(tournamentCode, name) {
  const key = teamKey(name);
  const found = stmts.selTeam.get(tournamentCode, key);
  if (found) return found.id;
  return Number(stmts.insTeam.run(tournamentCode, name, key).lastInsertRowid);
}

// Returns the players row id for an Embark ID, creating it on first sight.
// discordUsername is optional and only ever fills in a blank.
function upsertPlayer(embarkId, discordUsername) {
  const key = embarkKey(embarkId);
  if (!key) return null;
  const ts = now();
  const found = stmts.selPlayerByKey.get(key);
  if (found) {
    stmts.touchPlayer.run({ id: found.id, ts, discord_username: discordUsername || null });
    return found.id;
  }
  return Number(stmts.insPlayer.run({
    embark_id: String(embarkId).trim().replace(/^\[[^\]]*\]\s*/, ""),
    embark_key: key,
    base_key: baseKey(embarkId),
    discord_username: discordUsername || null,
    ts,
  }).lastInsertRowid);
}

// Resolve an on-screen name to a known player. Exact #tag match first; only
// fall back to the untagged base name when it is unambiguous.
function resolvePlayer(observedName) {
  const key = embarkKey(observedName);
  if (!key) return null;
  const exact = stmts.selPlayerByKey.get(key);
  if (exact) return exact;
  if (key.includes("#")) return null;
  const candidates = stmts.selPlayerByBase.all(key);
  return candidates.length === 1 ? candidates[0] : null;
}

function upsertTeamMember(teamId, playerId, discordUsername, isSub) {
  stmts.upsertMember.run({
    team_id: teamId, player_id: playerId,
    discord_username: discordUsername || null, is_sub: isSub ? 1 : 0,
  });
}

// --- moderators -------------------------------------------------------------
// Managed by the owners on the Users page of cb-stats-web. Kept in this file
// because the bot and the site already share it: a grant is visible to both on
// the moderator's next request, with no restart on either side.

function addModerator({ discord_id, username, added_by }) {
  stmts.addModerator.run({
    discord_id: String(discord_id),
    username: username || null,
    added_by: added_by || null,
    ts: now(),
  });
}

// True if the row existed (false tells the caller there was nothing to do).
function removeModerator(discordId) {
  return stmts.delModerator.run(String(discordId)).changes > 0;
}

function isModerator(discordId) {
  return !!stmts.selModerator.get(String(discordId || ""));
}

function listModerators() {
  return stmts.allModerators.all();
}

module.exports = {
  db, DB_PATH,
  embarkKey, baseKey, teamKey, toInt, now,
  upsertTournament, upsertTeam, upsertPlayer, upsertTeamMember, resolvePlayer,
  addModerator, removeModerator, isModerator, listModerators,
};
