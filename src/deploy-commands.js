require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('close').setDescription('Close the current modmail ticket'),
  new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is online'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    if (!process.env.CLIENT_ID || !process.env.GUILD_ID) {
      throw new Error('CLIENT_ID and GUILD_ID must be set in your environment (.env) before deploying commands.');
    }
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
