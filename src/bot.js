const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const { getConfig, saveConfig, getCategory } = require('./config');
const store = require('./store');
const { t } = require('./i18n');

// In-memory state for users mid-flow (not persisted on purpose: if the bot
// restarts, the user simply gets asked again on their next DM).
const pendingFlows = new Map(); // userId -> { step, lang, categoryId }

const GOLD = 0xc6a664;

function shortId() {
  return Date.now().toString(36).slice(-5);
}

function sanitizeChannelName(name) {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 20) || 'user'
  );
}

function buildWelcomeMessage() {
  return (
    '**Welcome to Signature.** / **Bienvenue sur Signature.**\n' +
    'Please choose your language to continue. / Merci de choisir votre langue pour continuer.'
  );
}

function buildLanguageRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modmail:lang:en').setLabel('English').setEmoji('🇬🇧').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modmail:lang:fr').setLabel('Français').setEmoji('🇫🇷').setStyle(ButtonStyle.Secondary),
  );
}

function buildCategorySelect(lang) {
  const cfg = getConfig();
  const options = cfg.categories.slice(0, 25).map((c) => ({
    label: (lang === 'fr' ? c.label_fr : c.label_en) || c.id,
    value: c.id,
    emoji: c.emoji || undefined,
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('modmail:category')
      .setPlaceholder(lang === 'fr' ? 'Choisir une catégorie...' : 'Choose a category...')
      .addOptions(options),
  );
}

function buildModal(category, lang) {
  const modal = new ModalBuilder().setCustomId('modmail:modal').setTitle(t(lang, 'modalTitle').slice(0, 45));
  const questions = (category.questions || []).slice(0, 5);
  for (const q of questions) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(((lang === 'fr' ? q.label_fr : q.label_en) || q.id).slice(0, 45))
      .setStyle(q.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setRequired(q.required !== false)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

async function ensureModmailCategory(guild) {
  const cfg = getConfig();
  if (cfg.settings.modmailCategoryId) {
    const existing = guild.channels.cache.get(cfg.settings.modmailCategoryId);
    if (existing) return existing.id;
  }
  const created = await guild.channels.create({
    name: 'Modmail Tickets',
    type: ChannelType.GuildCategory,
  });
  cfg.settings.modmailCategoryId = created.id;
  saveConfig(cfg);
  return created.id;
}

async function createTicketChannel(client, guild, user, category, lang, answers) {
  const parentId = await ensureModmailCategory(guild);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  for (const roleId of category.roleIds || []) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: `ticket-${sanitizeChannelName(user.username)}-${shortId()}`,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
    topic: `Modmail ticket for ${user.tag} (${user.id})`,
  });

  const cfg = getConfig();
  const langLabel = lang === 'fr' ? 'Français 🇫🇷' : 'English 🇬🇧';
  const catLabel = lang === 'fr' ? category.label_fr : category.label_en;

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(t(lang, 'newTicketChannelIntro'))
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag} (\`${user.id}\`)`, inline: false },
      { name: 'Language', value: langLabel, inline: true },
      { name: 'Category', value: catLabel, inline: true },
    )
    .setFooter({ text: cfg.settings.teamName })
    .setTimestamp();

  for (const [key, value] of Object.entries(answers)) {
    const q = (category.questions || []).find((qq) => qq.id === key);
    const label = q ? (lang === 'fr' ? q.label_fr : q.label_en) : key;
    embed.addFields({ name: label.slice(0, 256), value: (value || '—').slice(0, 1024) });
  }

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modmail:close:${user.id}`).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

  await channel.send({ content: category.roleIds?.length ? category.roleIds.map((r) => `<@&${r}>`).join(' ') : undefined, embeds: [embed], components: [closeRow] });

  store.createTicket(user.id, {
    channelId: channel.id,
    guildId: guild.id,
    categoryId: category.id,
    language: lang,
    openedAt: Date.now(),
  });

  return channel;
}

async function handleNewDM(message) {
  const userId = message.author.id;
  if (pendingFlows.has(userId)) return; // already mid-flow, buttons already sent
  pendingFlows.set(userId, { step: 'language' });
  await message.channel.send({ content: buildWelcomeMessage(), components: [buildLanguageRow()] }).catch(() => {});
}

async function handleDM(client, message) {
  const userId = message.author.id;
  const ticket = store.getTicketByUser(userId);

  if (ticket) {
    const guild = client.guilds.cache.get(ticket.guildId);
    const channel = guild?.channels.cache.get(ticket.channelId);
    if (!channel) {
      // Channel was deleted manually without going through the close flow - clean up.
      store.deleteTicketByUser(userId);
      return handleNewDM(message);
    }
    const embed = new EmbedBuilder()
      .setColor(GOLD)
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(message.content || '*(no text content)*')
      .setTimestamp();
    const files = [...message.attachments.values()].map((a) => ({ attachment: a.url, name: a.name }));
    await channel.send({ embeds: [embed], files }).catch(() => {});
    await message.react('✅').catch(() => {});
    return;
  }

  const pending = pendingFlows.get(userId);
  if (pending) {
    await message.channel.send(t(pending.lang || 'en', 'waitingForButtons')).catch(() => {});
    return;
  }

  return handleNewDM(message);
}

async function handleGuildMessage(message) {
  if (!message.guild) return;
  const ticket = store.getTicketByChannel(message.channel.id);
  if (!ticket) return;
  if (message.content.startsWith('!')) return; // internal staff note, not forwarded

  const user = await message.client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const cfg = getConfig();
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setAuthor({ name: `${cfg.settings.teamName} — ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
    .setDescription(message.content || '*(no text content)*')
    .setTimestamp();
  const files = [...message.attachments.values()].map((a) => ({ attachment: a.url, name: a.name }));

  await user.send({ embeds: [embed], files }).catch(async () => {
    await message.channel.send('⚠️ Could not deliver this message — the user may have DMs closed.').catch(() => {});
  });
}

async function closeTicket(client, userId, closedBy) {
  const ticket = store.getTicketByUser(userId);
  if (!ticket) return false;
  const guild = client.guilds.cache.get(ticket.guildId);
  const channel = guild?.channels.cache.get(ticket.channelId);

  const user = await client.users.fetch(userId).catch(() => null);
  if (user) {
    await user.send(t(ticket.language, 'ticketClosedDM')).catch(() => {});
  }
  if (channel) {
    await channel.delete(`Ticket closed by ${closedBy || 'staff'}`).catch(() => {});
  }
  store.deleteTicketByUser(userId);
  pendingFlows.delete(userId);
  return true;
}

function createBotClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once('ready', () => {
    console.log(`Signature Modmail — logged in as ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (message.channel.type === ChannelType.DM) {
        await handleDM(client, message);
      } else if (message.guild) {
        await handleGuildMessage(message);
      }
    } catch (err) {
      console.error('messageCreate error:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith('modmail:lang:')) {
        const lang = interaction.customId.split(':')[2];
        pendingFlows.set(interaction.user.id, { step: 'category', lang });
        await interaction.update({ content: t(lang, 'chooseCategory'), components: [buildCategorySelect(lang)] });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'modmail:category') {
        const pending = pendingFlows.get(interaction.user.id) || { lang: 'en' };
        const categoryId = interaction.values[0];
        const category = getCategory(categoryId);
        if (!category) {
          await interaction.reply({ content: 'This category no longer exists, please try again.', ephemeral: true });
          return;
        }
        pendingFlows.set(interaction.user.id, { step: 'modal', lang: pending.lang, categoryId });
        await interaction.showModal(buildModal(category, pending.lang));
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId === 'modmail:modal') {
        const pending = pendingFlows.get(interaction.user.id);
        if (!pending || !pending.categoryId) {
          await interaction.reply({ content: 'Your session expired, please send a new DM to start again.', ephemeral: true });
          return;
        }
        const category = getCategory(pending.categoryId);
        const guild = interaction.client.guilds.cache.get(process.env.GUILD_ID);
        if (!category || !guild) {
          await interaction.reply({ content: 'Something went wrong, please try again later.', ephemeral: true });
          return;
        }
        await interaction.deferReply();
        const answers = {};
        for (const q of category.questions || []) {
          answers[q.id] = interaction.fields.getTextInputValue(q.id);
        }
        await createTicketChannel(interaction.client, guild, interaction.user, category, pending.lang, answers);
        pendingFlows.delete(interaction.user.id);
        await interaction.editReply({ content: t(pending.lang, 'ticketCreatedDM') });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('modmail:close:')) {
        const userId = interaction.customId.split(':')[2];
        await interaction.reply({ content: '🔒 Closing this ticket...', ephemeral: false });
        await closeTicket(interaction.client, userId, interaction.user.tag);
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
        const ticket = store.getTicketByChannel(interaction.channel.id);
        if (!ticket) {
          await interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });
          return;
        }
        await interaction.reply({ content: '🔒 Closing this ticket...', ephemeral: false });
        await closeTicket(interaction.client, ticket.userId, interaction.user.tag);
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
        await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
      }
    } catch (err) {
      console.error('interactionCreate error:', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An unexpected error occurred.', ephemeral: true }).catch(() => {});
      }
    }
  });

  return client;
}

module.exports = { createBotClient, closeTicket };
