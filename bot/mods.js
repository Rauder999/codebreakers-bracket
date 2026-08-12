// ============================================================================
// Moderator management from inside Discord: /mod add | remove | list.
//
// Why: confirming screenshot results (results.js) and correcting stats on the
// site (cb-stats-web) were gated on the Discord "Manage Server" permission or
// the static stats.adminDiscordIds list -- adding a tournament moderator meant
// editing config.json on the VM. Now the owners (stats.adminDiscordIds) grant
// and revoke moderator status with a slash command; the grant lands in the
// moderators table of the shared stats DB and both gates honour it instantly:
//   * results.js accepts stored moderators on the Apply/Reject buttons,
//   * cb-stats-web resolves the admin role from the table on every request.
//
// Owners stay config-only on purpose: whoever can grant moderator must not be
// grantable from Discord, or one compromised mod account could mint more.
//
// If better-sqlite3 is not built on this host the commands say so and the
// gates fall back to the old behaviour -- same policy as results.js: pings
// and results must never die because of the stats stack.
//
// Unicode is written as \uXXXX escapes on purpose: these files travel to the
// VM through pipes that have mangled raw UTF-8 before.
// ============================================================================
const {
  SlashCommandBuilder,
  InteractionContextType,
  PermissionFlagsBits,
} = require("discord.js");

module.exports = function setupMods(ctx) {
  const { client, CFG, cliMode } = ctx;
  const S = CFG.stats || {};
  const ownerIds = new Set((S.adminDiscordIds || []).map(String));

  // The stats store is optional, exactly as in results.js.
  let store = null;
  try { store = require("./stats/db"); }
  catch (e) { console.error("mods: stats store unavailable, /mod add|remove disabled:", e.message); }

  // The questions the rest of the bot asks this module. Owners are always
  // moderators; everyone else needs a row in the moderators table.
  function isModerator(discordId) {
    const id = String(discordId || "");
    if (ownerIds.has(id)) return true;
    try { return store ? store.isModerator(id) : false; }
    catch (e) { console.error("mods: isModerator failed:", e.message); return false; }
  }

  // Everyone who should be pinged when a result is disputed (results.js).
  function moderatorIds() {
    const ids = [...ownerIds];
    try {
      if (store) for (const r of store.listModerators()) if (!ownerIds.has(r.discord_id)) ids.push(r.discord_id);
    } catch (e) { console.error("mods: moderatorIds failed:", e.message); }
    return ids;
  }

  // Default visibility is Manage Server so the command stays out of regular
  // players' pickers; the hard gate for add/remove is the owner check below.
  const command = new SlashCommandBuilder()
    .setName("mod")
    .setDescription("Manage CodeBreakers bot moderators")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc
      .setName("add")
      .setDescription("Grant moderator status: confirm match results, correct stats")
      .addUserOption((o) => o.setName("user").setDescription("Member to make a moderator").setRequired(true)))
    .addSubcommand((sc) => sc
      .setName("remove")
      .setDescription("Revoke moderator status granted with /mod add")
      .addUserOption((o) => o.setName("user").setDescription("Moderator to remove").setRequired(true)))
    .addSubcommand((sc) => sc
      .setName("list")
      .setDescription("List the bot's owners and moderators"));

  client.once("clientReady", async () => {
    if (cliMode) return; // one-shot CLI runs (sync-roles) must not touch commands
    try {
      // Global registration: survives the move from the test server to the
      // production CODE server with nothing to re-run. set() replaces all
      // global commands, which is fine -- /mod is the only one.
      await client.application.commands.set([command.toJSON()]);
      console.log("mods: /mod slash command registered (global)");
    } catch (e) {
      console.error("mods: slash command registration failed:", e.message);
    }
  });

  const mention = (id) => `<@${id}>`;
  const NO_PINGS = { parse: [] }; // mentions render as names but never notify

  async function onCommand(i) {
    if (!i.isChatInputCommand() || i.commandName !== "mod") return;
    const sub = i.options.getSubcommand();

    if (sub === "list") {
      const owners = [...ownerIds].map((id) => `${mention(id)} \u2014 owner`);
      let stored = [];
      if (store) {
        stored = store.listModerators()
          .filter((r) => !ownerIds.has(r.discord_id))
          .map((r) => `${mention(r.discord_id)} \u2014 added by ${r.added_by || "?"} on <t:${Math.floor(r.added_at / 1000)}:D>`);
      }
      const lines = [...owners, ...stored];
      await i.reply({
        content: `**Moderators** (can confirm results and correct stats)\n${lines.join("\n") || "(none)"}`,
        allowedMentions: NO_PINGS,
      });
      return;
    }

    if (!ownerIds.has(i.user.id)) {
      await i.reply({ content: "Only the bot owners can manage moderators.", ephemeral: true });
      return;
    }
    if (!store) {
      await i.reply({ content: "The moderator store is unavailable on this host (better-sqlite3 failed to load) \u2014 see the service logs.", ephemeral: true });
      return;
    }

    const target = i.options.getUser("user", true);

    if (sub === "add") {
      if (target.bot) {
        await i.reply({ content: "Bots cannot be moderators.", ephemeral: true });
        return;
      }
      if (ownerIds.has(target.id)) {
        await i.reply({ content: `${mention(target.id)} is an owner (config.json) and already has everything a moderator has.`, allowedMentions: NO_PINGS, ephemeral: true });
        return;
      }
      const existed = store.isModerator(target.id);
      store.addModerator({ discord_id: target.id, username: target.username, added_by: i.user.username });
      console.log(`mods: ${i.user.username} ${existed ? "re-added" : "added"} moderator ${target.username} (${target.id})`);
      await i.reply({
        content: existed
          ? `${mention(target.id)} is already a moderator.`
          : `\u2705 ${mention(target.id)} is now a moderator \u2014 they can confirm match results in Discord and correct stats on ${S.baseUrl || "the stats site"}.`,
        allowedMentions: NO_PINGS,
      });
      return;
    }

    if (sub === "remove") {
      if (ownerIds.has(target.id)) {
        await i.reply({ content: `${mention(target.id)} is an owner \u2014 owners live in config.json and cannot be removed from Discord.`, allowedMentions: NO_PINGS, ephemeral: true });
        return;
      }
      const removed = store.removeModerator(target.id);
      if (removed) console.log(`mods: ${i.user.username} removed moderator ${target.username} (${target.id})`);
      await i.reply({
        content: removed
          ? `\uD83D\uDEAB ${mention(target.id)} is no longer a moderator.`
          : `${mention(target.id)} was not a moderator.`,
        allowedMentions: NO_PINGS,
      });
    }
  }

  client.on("interactionCreate", (i) => { onCommand(i).catch((e) => console.error("mods onCommand:", e.message)); });
  console.log(`mods: /mod moderator management armed (${ownerIds.size} owner(s)${store ? "" : ", store OFF"})`);
  return { isModerator, moderatorIds };
};
