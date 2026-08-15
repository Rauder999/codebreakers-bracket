// ============================================================================
// Print the Discord id of everyone on the bot's server, optionally filtered.
//
//   cd /opt/cb-bot && node tools/list-members.js            # everyone
//   cd /opt/cb-bot && node tools/list-members.js playr      # substring match
//
// Exists because `stats.adminDiscordIds` in config.json wants snowflake ids,
// and there is no way to eyeball those from the Discord client without turning
// on developer mode. Read-only; uses the bot token already in .env.
// ============================================================================
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");

const root = path.join(__dirname, "..");
const envText = fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8") : "";
const ENV = Object.fromEntries(envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const needle = String(process.argv[2] || "").toLowerCase();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("clientReady", async () => {
  for (const guild of client.guilds.cache.values()) {
    console.log(`\n=== ${guild.name} (${guild.id}) ===`);
    let members;
    try { members = await guild.members.fetch(); }
    catch (e) { console.error(`  members fetch failed (Server Members Intent enabled?): ${e.message}`); continue; }

    const rows = [...members.values()]
      .filter((m) => {
        if (!needle) return true;
        return [m.user.username, m.user.globalName, m.nickname]
          .filter(Boolean).some((s) => s.toLowerCase().includes(needle));
      })
      .sort((a, b) => a.user.username.localeCompare(b.user.username));

    for (const m of rows) {
      const display = m.nickname || m.user.globalName || "";
      const owner = m.id === guild.ownerId ? "  [server owner]" : "";
      console.log(`  ${m.id}  ${m.user.username}${display ? `  (${display})` : ""}${owner}`);
    }
    if (!rows.length) console.log("  (no match)");
  }
  client.destroy();
});

client.login(ENV.DISCORD_BOT_TOKEN);
