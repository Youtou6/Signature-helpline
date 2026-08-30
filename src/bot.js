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
const archive = require('./archive');
const { t, fill } = require('./i18n');
const { planNext, buildChoiceRow, buildModalForBatch } = require('./flow');

// In-memory state for users mid-flow (not persisted on purpose: if the bot
// restarts, the user simply gets asked again on their next DM).
const pendingFlows = new Map(); // userId -> { step, lang, categoryId, answers, ..., redirectChannelId? }

const GOLD = 0xc6a664;
const AUTO_CLOSE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

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

function buildOverwrites(guild, client, category) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.MentionEveryone, // needed for role pings to actually notify, even if a role isn't "mentionable"
      ],
    },
  ];
  for (const roleId of category.roleIds || []) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }
  return overwrites;
}

async function ensureModmailCategory(guild) {
  const cfg = getConfig();
  if (cfg.settings.modmailCategoryId) {
    const existing = guild.channels.cache.get(cfg.settings.modmailCategoryId);
    if (existing) return existing.id;
  }
  const created = await guild.channels.create({ name: 'Modmail Tickets', type: ChannelType.GuildCategory });
  cfg.settings.modmailCategoryId = created.id;
  saveConfig(cfg);
  return created.id;
}

async function ensureLogChannel(guild, client) {
  const cfg = getConfig();
  if (cfg.settings.logChannelId) {
    const existing = guild.channels.cache.get(cfg.settings.logChannelId);
    if (existing) return existing;
  }
  const parentId = await ensureModmailCategory(guild);
  const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }];
  if (cfg.settings.pingRoleId) {
    overwrites.push({ id: cfg.settings.pingRoleId, allow: [PermissionFlagsBits.ViewChannel] });
  }
  const created = await guild.channels.create({
    name: 'modmail-logs',
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
    topic: 'Automatic log of modmail events (tickets opened/closed/redirected/claimed).',
  });
  cfg.settings.logChannelId = created.id;
  saveConfig(cfg);
  return created;
}

async function logEvent(guild, client, content) {
  try {
    const channel = await ensureLogChannel(guild, client);
    await channel.send({ content: content.slice(0, 1900) });
  } catch (err) {
    console.error('logEvent error:', err);
  }
}

function summarizeAnswers(category, lang, answers) {
  const lines = [];
  for (const [key, value] of Object.entries(answers || {})) {
    if (value === null || value === undefined) continue;
    const q = (category.questions || []).find((qq) => qq.id === key);
    if (!q) continue;
    let displayValue = value;
    if (q.type === 'choice') {
      const opt = (q.options || []).find((o) => o.id === value);
      displayValue = opt ? (lang === 'fr' ? opt.label_fr : opt.label_en) : value;
    }
    const label = lang === 'fr' ? q.label_fr : q.label_en;
    lines.push(`${label}: ${displayValue}`);
  }
  return lines.join('\n');
}

function buildTicketEmbed(cfg, user, category, lang, answers) {
  const langLabel = lang === 'fr' ? 'Français 🇫🇷' : 'English 🇬🇧';
  const catLabel = lang === 'fr' ? category.label_fr : category.label_en;
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(t(cfg, lang, 'newTicketChannelIntro'))
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${user.tag} (\`${user.id}\`)`, inline: false },
      { name: 'Language', value: langLabel, inline: true },
      { name: 'Category', value: catLabel, inline: true },
    )
    .setFooter({ text: cfg.settings.teamName })
    .setTimestamp();

  for (const [key, value] of Object.entries(answers)) {
    if (value === null || value === undefined) continue; // skipped (not applicable) question
    const q = (category.questions || []).find((qq) => qq.id === key);
    if (!q) continue;
    let displayValue = value;
    if (q.type === 'choice') {
      const opt = (q.options || []).find((o) => o.id === value);
      displayValue = opt ? (lang === 'fr' ? opt.label_fr : opt.label_en) : value;
    }
    const label = q ? (lang === 'fr' ? q.label_fr : q.label_en) : key;
    embed.addFields({ name: String(label).slice(0, 256), value: String(displayValue || '—').slice(0, 1024) });
  }
  return embed;
}

function buildTicketActionRow(userId, claimed) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modmail:close:${userId}`).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`modmail:redirect:${userId}`).setLabel('Redirect').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`modmail:claim:${userId}`)
      .setLabel(claimed ? 'Unclaim' : 'Claim')
      .setEmoji('🙋')
      .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
}

async function refreshTicketMessage(client, guild, userId, ticket) {
  const channel = guild.channels.cache.get(ticket.channelId);
  if (!channel || !ticket.ticketMessageId) return;
  const category = getCategory(ticket.categoryId);
  const msg = await channel.messages.fetch(ticket.ticketMessageId).catch(() => null);
  if (!msg || !msg.embeds[0]) return;

  const fields = msg.embeds[0].fields.map((f) => ({ ...f }));
  const catIdx = fields.findIndex((f) => f.name === 'Category');
  if (catIdx !== -1 && category) fields[catIdx].value = category.label_en;
  const claimIdx = fields.findIndex((f) => f.name === 'Claimed by');
  if (ticket.claimedBy) {
    const claimField = { name: 'Claimed by', value: `<@${ticket.claimedBy}>`, inline: true };
    if (claimIdx !== -1) fields[claimIdx] = claimField;
    else fields.push(claimField);
  } else if (claimIdx !== -1) {
    fields.splice(claimIdx, 1);
  }
  const embed = EmbedBuilder.from(msg.embeds[0]).setFields(fields);
  await msg.edit({ embeds: [embed], components: [buildTicketActionRow(userId, !!ticket.claimedBy)] }).catch(() => {});
}

async function createTicketChannel(client, guild, user, category, lang, answers) {
  const parentId = await ensureModmailCategory(guild);
  const cfg = getConfig();

  const channel = await guild.channels.create({
    name: `ticket-${sanitizeChannelName(user.username)}-${shortId()}`,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: buildOverwrites(guild, client, category),
    topic: `Modmail ticket for ${user.tag} (${user.id})`,
  });

  const embed = buildTicketEmbed(cfg, user, category, lang, answers);
  const pingParts = [...(category.roleIds || [])];
  if (cfg.settings.pingRoleId && !pingParts.includes(cfg.settings.pingRoleId)) pingParts.push(cfg.settings.pingRoleId);
  const pingContent = pingParts.length ? pingParts.map((r) => `<@&${r}>`).join(' ') : undefined;

  const sentMessage = await channel.send({ content: pingContent, embeds: [embed], components: [buildTicketActionRow(user.id, false)] });

  store.createTicket(user.id, {
    channelId: channel.id,
    guildId: guild.id,
    categoryId: category.id,
    language: lang,
    openedAt: Date.now(),
    ticketMessageId: sentMessage.id,
  });

  store.appendTranscript(user.id, {
    from: 'system',
    authorTag: 'System',
    content: `Ticket opened — category: ${category.label_en}, language: ${lang}.${summarizeAnswers(category, lang, answers) ? `\n${summarizeAnswers(category, lang, answers)}` : ''}`,
  });

  await logEvent(guild, client, `🆕 **New ticket** — ${user.tag} — category **${category.label_en}** — <#${channel.id}>`);

  return channel;
}

// ---- Question flow presentation helpers (shared by the "new ticket" flow AND the "redirect follow-up" flow) ----

async function finalizeTicket(interaction, mode, categoryId, lang, answers, redirectChannelId) {
  const category = getCategory(categoryId);
  const guild = interaction.client.guilds.cache.get(process.env.GUILD_ID);
  const cfg = getConfig();

  if (mode === 'update') await interaction.deferUpdate();
  else await interaction.deferReply();

  if (!category || !guild) {
    const msg = 'Something went wrong, please try again later. / Une erreur est survenue, merci de réessayer plus tard.';
    await interaction.editReply({ content: msg, components: [] });
    return;
  }

  if (redirectChannelId) {
    const channel = guild.channels.cache.get(redirectChannelId);
    if (channel) {
      const embed = buildTicketEmbed(cfg, interaction.user, category, lang, answers).setTitle(
        lang === 'fr' ? 'Réponses au nouveau questionnaire' : 'New questionnaire answers',
      );
      await channel.send({ embeds: [embed] }).catch(() => {});
      const ticket = store.getTicketByUser(interaction.user.id);
      if (ticket) {
        store.appendTranscript(interaction.user.id, {
          from: 'system',
          authorTag: 'System',
          content: `Redirect questionnaire answered:\n${summarizeAnswers(category, lang, answers)}`,
        });
      }
    }
    pendingFlows.delete(interaction.user.id);
    await interaction.editReply({ content: t(cfg, lang, 'redirectFollowupDoneDM'), components: [] });
    return;
  }

  await createTicketChannel(interaction.client, guild, interaction.user, category, lang, answers);
  pendingFlows.delete(interaction.user.id);
  await interaction.editReply({ content: t(cfg, lang, 'ticketCreatedDM'), components: [] });
}

async function presentPlanFromSelect(interaction, plan, categoryId, lang, redirectChannelId) {
  if (plan.type === 'choice') {
    pendingFlows.set(interaction.user.id, { step: 'awaiting_choice', lang, categoryId, answers: plan.answers, currentQuestionId: plan.question.id, redirectChannelId });
    const content = (lang === 'fr' ? plan.question.label_fr : plan.question.label_en) || '...';
    await interaction.update({ content, components: [buildChoiceRow(plan.question, lang)] });
    return;
  }
  if (plan.type === 'text') {
    pendingFlows.set(interaction.user.id, { step: 'awaiting_modal', lang, categoryId, answers: plan.answers, currentBatchIds: plan.questions.map((q) => q.id), redirectChannelId });
    const cfg = getConfig();
    await interaction.showModal(buildModalForBatch(plan.questions, lang, t(cfg, lang, 'modalTitle')));
    return;
  }
  await finalizeTicket(interaction, 'update', categoryId, lang, plan.answers, redirectChannelId);
}

async function presentPlanFromModalSubmit(interaction, plan, categoryId, lang, redirectChannelId) {
  if (plan.type === 'choice') {
    pendingFlows.set(interaction.user.id, { step: 'awaiting_choice', lang, categoryId, answers: plan.answers, currentQuestionId: plan.question.id, redirectChannelId });
    const content = (lang === 'fr' ? plan.question.label_fr : plan.question.label_en) || '...';
    await interaction.reply({ content, components: [buildChoiceRow(plan.question, lang)] });
    return;
  }
  if (plan.type === 'text') {
    // Discord does not allow chaining a modal directly from a modal submit -
    // ask the user to tap Continue, which is a button interaction and CAN open one.
    pendingFlows.set(interaction.user.id, { step: 'awaiting_continue', lang, categoryId, answers: plan.answers, currentBatchIds: plan.questions.map((q) => q.id), redirectChannelId });
    const continueRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('modmail:continueModal').setLabel(lang === 'fr' ? 'Continuer' : 'Continue').setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({ content: lang === 'fr' ? 'Merci ! Encore quelques questions.' : 'Thanks! A couple more questions.', components: [continueRow] });
    return;
  }
  await finalizeTicket(interaction, 'reply', categoryId, lang, plan.answers, redirectChannelId);
}

async function startRedirectQuestionnaire(client, userId, newCategory, lang, channelId) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  const cfg = getConfig();
  const plan = planNext(newCategory, {});

  if (plan.type === 'done') {
    await user.send(t(cfg, lang, 'redirectSimpleNoticeDM')).catch(() => {});
    return;
  }

  const promptText = t(cfg, lang, 'redirectFollowupPromptDM');
  if (plan.type === 'choice') {
    pendingFlows.set(userId, { step: 'awaiting_choice', lang, categoryId: newCategory.id, answers: plan.answers, currentQuestionId: plan.question.id, redirectChannelId: channelId });
    const content = `${promptText}\n\n${lang === 'fr' ? plan.question.label_fr : plan.question.label_en}`;
    await user.send({ content, components: [buildChoiceRow(plan.question, lang)] }).catch(() => {});
    return;
  }
  // type 'text' - a batch is ready but we need a button click before showModal is legal.
  pendingFlows.set(userId, { step: 'awaiting_continue', lang, categoryId: newCategory.id, answers: plan.answers, currentBatchIds: plan.questions.map((q) => q.id), redirectChannelId: channelId });
  const continueRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modmail:continueModal').setLabel(lang === 'fr' ? 'Répondre' : 'Answer').setStyle(ButtonStyle.Primary),
  );
  await user.send({ content: promptText, components: [continueRow] }).catch(() => {});
}

// ---- DM intake ----

async function handleNewDM(message) {
  const userId = message.author.id;
  if (pendingFlows.has(userId)) return; // already mid-flow, buttons already sent
  pendingFlows.set(userId, { step: 'language' });
  const cfg = getConfig();
  await message.channel.send({ content: t(cfg, 'en', 'welcome'), components: [buildLanguageRow()] }).catch(() => {});
}

async function handleDM(client, message) {
  const userId = message.author.id;
  const ticket = store.getTicketByUser(userId);

  if (ticket) {
    const guild = client.guilds.cache.get(ticket.guildId);
    const channel = guild?.channels.cache.get(ticket.channelId);
    if (!channel) {
      store.deleteTicketByUser(userId); // channel deleted manually - clean up and restart
      return handleNewDM(message);
    }
    const files = [...message.attachments.values()].map((a) => ({ attachment: a.url, name: a.name }));
    const embed = new EmbedBuilder()
      .setColor(GOLD)
      .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
      .setDescription(message.content || '*(no text content)*')
      .setTimestamp();

    store.appendTranscript(userId, { from: 'user', authorTag: message.author.tag, content: message.content, attachments: files.map((f) => f.attachment) });
    store.updateTicket(userId, { lastActivityAt: Date.now(), warningSentAt: null });

    await channel.send({ embeds: [embed], files }).catch(() => {});
    await message.react('✅').catch(() => {});
    return;
  }

  const pending = pendingFlows.get(userId);
  if (pending) {
    const cfg = getConfig();
    await message.channel.send(t(cfg, pending.lang || 'en', 'waitingForButtons')).catch(() => {});
    return;
  }

  return handleNewDM(message);
}

async function handleGuildMessage(message) {
  if (!message.guild) return;
  const ticket = store.getTicketByChannel(message.channel.id);
  if (!ticket) return;

  if (message.content.startsWith('!')) {
    // Internal staff note - logged for the transcript, never forwarded to the user.
    store.appendTranscript(ticket.userId, { from: 'note', authorTag: message.author.tag, content: message.content.slice(1).trim() });
    store.updateTicket(ticket.userId, { lastActivityAt: Date.now(), warningSentAt: null, staffReplied: true });
    return;
  }

  const attachments = [...message.attachments.values()].map((a) => a.url);
  store.appendTranscript(ticket.userId, { from: 'staff', authorTag: message.author.tag, content: message.content, attachments });
  store.updateTicket(ticket.userId, { lastActivityAt: Date.now(), warningSentAt: null, staffReplied: true });

  const user = await message.client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const cfg = getConfig();
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setAuthor({ name: `${cfg.settings.teamName} — ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })
    .setDescription(message.content || '*(no text content)*')
    .setTimestamp();
  const files = attachments.map((url) => ({ attachment: url }));

  await user.send({ embeds: [embed], files }).catch(async () => {
    await message.channel.send('⚠️ Could not deliver this message — the user may have DMs closed.').catch(() => {});
  });
}

// ---- Close + rating ----

async function sendRatingRequest(user, lang, archiveId) {
  const cfg = getConfig();
  const row = new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map((n) =>
      new ButtonBuilder().setCustomId(`modmail:rate:${archiveId}:${n}`).setLabel(String(n)).setEmoji('⭐').setStyle(ButtonStyle.Secondary),
    ),
  );
  await user.send({ content: t(cfg, lang, 'ratingRequestDM'), components: [row] });
}

async function closeTicket(client, userId, closedBy, reason = 'staff') {
  const ticket = store.getTicketByUser(userId);
  if (!ticket) return false;
  const guild = client.guilds.cache.get(ticket.guildId);
  const channel = guild?.channels.cache.get(ticket.channelId);
  const category = getCategory(ticket.categoryId);
  const cfg = getConfig();
  const user = await client.users.fetch(userId).catch(() => null);

  store.appendTranscript(userId, {
    from: 'system',
    authorTag: 'System',
    content: reason === 'auto' ? 'Ticket auto-closed due to inactivity.' : `Ticket closed by ${closedBy}.`,
  });
  const freshTicket = store.getTicketByUser(userId);

  const archiveEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    userId,
    userTag: user ? user.tag : userId,
    guildId: ticket.guildId,
    categoryId: ticket.categoryId,
    categoryLabelEn: category ? category.label_en : ticket.categoryId,
    language: ticket.language || 'en',
    openedAt: ticket.openedAt,
    closedAt: Date.now(),
    closedBy,
    closedReason: reason,
    transcript: freshTicket ? freshTicket.transcript || [] : ticket.transcript || [],
    rating: null,
  };
  archive.addEntry(archiveEntry);

  if (user) {
    await user.send(t(cfg, ticket.language, 'ticketClosedDM')).catch(() => {});
    await sendRatingRequest(user, ticket.language || 'en', archiveEntry.id).catch(() => {});
  }
  if (guild) {
    await logEvent(
      guild,
      client,
      reason === 'auto'
        ? `⏱️ **Auto-closed (inactivity)** — ${archiveEntry.userTag} — category **${archiveEntry.categoryLabelEn}**`
        : `🔒 **Ticket closed** by ${closedBy} — ${archiveEntry.userTag} — category **${archiveEntry.categoryLabelEn}**`,
    );
  }
  if (channel) {
    await channel.delete(`Ticket closed by ${closedBy || 'staff'}`).catch(() => {});
  }
  store.deleteTicketByUser(userId);
  pendingFlows.delete(userId);
  return true;
}

// ---- Auto-close on inactivity ----

function startAutoCloseScheduler(client) {
  setInterval(async () => {
    try {
      const cfg = getConfig();
      const autoClose = cfg.settings.autoClose || {};
      if (autoClose.enabled === false) return;
      const inactivityMs = (autoClose.inactivityHours ?? 24) * 3600 * 1000;
      const graceMs = (autoClose.graceMinutes ?? 60) * 60 * 1000;
      const now = Date.now();
      const all = store.readAll();

      for (const [userId, ticket] of Object.entries(all)) {
        if (!ticket.staffReplied) continue; // staff can take as long as they want before the first reply
        const lastActivity = ticket.lastActivityAt || ticket.openedAt || now;

        if (!ticket.warningSentAt) {
          if (now - lastActivity >= inactivityMs) {
            const user = await client.users.fetch(userId).catch(() => null);
            if (user) await user.send(t(cfg, ticket.language || 'en', 'inactivityWarningDM')).catch(() => {});
            store.appendTranscript(userId, { from: 'system', authorTag: 'System', content: 'Inactivity warning sent to the user (auto-close in 1h if no reply).' });
            store.updateTicket(userId, { warningSentAt: now });

            const guild = client.guilds.cache.get(ticket.guildId);
            const channel = guild?.channels.cache.get(ticket.channelId);
            if (channel) {
              await channel
                .send('⏳ *No reply from the user in a while — a warning was just sent to them. This ticket will auto-close in about 1h if they stay silent.*')
                .catch(() => {});
            }
          }
        } else if (now - ticket.warningSentAt >= graceMs) {
          await closeTicket(client, userId, `${cfg.settings.teamName} (auto-close)`, 'auto');
        }
      }
    } catch (err) {
      console.error('Auto-close scheduler error:', err);
    }
  }, AUTO_CLOSE_CHECK_INTERVAL_MS);
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
    startAutoCloseScheduler(client);
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
      // --- Language & category intake ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:lang:')) {
        const lang = interaction.customId.split(':')[2];
        pendingFlows.set(interaction.user.id, { step: 'category', lang });
        const cfg = getConfig();
        await interaction.update({ content: t(cfg, lang, 'chooseCategory'), components: [buildCategorySelect(lang)] });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'modmail:category') {
        const pending = pendingFlows.get(interaction.user.id) || {};
        const lang = pending.lang || 'en';
        const category = getCategory(interaction.values[0]);
        if (!category) {
          await interaction.reply({ content: 'This category no longer exists, please try again.', ephemeral: true });
          return;
        }
        const plan = planNext(category, {});
        await presentPlanFromSelect(interaction, plan, category.id, lang, undefined);
        return;
      }

      // --- Conditional question flow (shared by new tickets AND redirect follow-ups) ---
      if (interaction.isStringSelectMenu() && interaction.customId === 'modmail:choice') {
        const pending = pendingFlows.get(interaction.user.id);
        if (!pending || pending.step !== 'awaiting_choice') {
          await interaction.reply({ content: 'Session expired — please send a new DM to start again. / Session expirée — merci de renvoyer un message.', ephemeral: true });
          return;
        }
        const category = getCategory(pending.categoryId);
        if (!category) {
          await interaction.reply({ content: 'Something went wrong, please try again.', ephemeral: true });
          return;
        }
        const answers = { ...pending.answers, [pending.currentQuestionId]: interaction.values[0] };
        const plan = planNext(category, answers);
        await presentPlanFromSelect(interaction, plan, pending.categoryId, pending.lang, pending.redirectChannelId);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId === 'modmail:modal') {
        const pending = pendingFlows.get(interaction.user.id);
        if (!pending || pending.step !== 'awaiting_modal') {
          await interaction.reply({ content: 'Session expired — please send a new DM to start again. / Session expirée — merci de renvoyer un message.', ephemeral: true });
          return;
        }
        const category = getCategory(pending.categoryId);
        if (!category) {
          await interaction.reply({ content: 'Something went wrong, please try again.', ephemeral: true });
          return;
        }
        const answers = { ...pending.answers };
        for (const id of pending.currentBatchIds) answers[id] = interaction.fields.getTextInputValue(id);
        const plan = planNext(category, answers);
        await presentPlanFromModalSubmit(interaction, plan, pending.categoryId, pending.lang, pending.redirectChannelId);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'modmail:continueModal') {
        const pending = pendingFlows.get(interaction.user.id);
        if (!pending || pending.step !== 'awaiting_continue') {
          await interaction.reply({ content: 'Session expired — please send a new DM to start again. / Session expirée — merci de renvoyer un message.', ephemeral: true });
          return;
        }
        const category = getCategory(pending.categoryId);
        if (!category) {
          await interaction.reply({ content: 'Something went wrong, please try again.', ephemeral: true });
          return;
        }
        const questions = pending.currentBatchIds.map((id) => (category.questions || []).find((q) => q.id === id)).filter(Boolean);
        pendingFlows.set(interaction.user.id, {
          step: 'awaiting_modal',
          lang: pending.lang,
          categoryId: pending.categoryId,
          answers: pending.answers,
          currentBatchIds: pending.currentBatchIds,
          redirectChannelId: pending.redirectChannelId,
        });
        const cfg = getConfig();
        await interaction.showModal(buildModalForBatch(questions, pending.lang, t(cfg, pending.lang, 'modalTitle')));
        return;
      }

      // --- Close ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:close:')) {
        const userId = interaction.customId.split(':')[2];
        await interaction.reply({ content: '🔒 Closing this ticket...', ephemeral: false });
        await closeTicket(interaction.client, userId, interaction.user.tag, 'staff');
        return;
      }

      if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
        const ticket = store.getTicketByChannel(interaction.channel.id);
        if (!ticket) {
          await interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });
          return;
        }
        await interaction.reply({ content: '🔒 Closing this ticket...', ephemeral: false });
        await closeTicket(interaction.client, ticket.userId, interaction.user.tag, 'staff');
        return;
      }

      // --- Claim / Unclaim ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:claim:')) {
        const userId = interaction.customId.split(':')[2];
        const ticket = store.getTicketByUser(userId);
        if (!ticket) {
          await interaction.reply({ content: 'This ticket is no longer open.', ephemeral: true });
          return;
        }
        if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
          await interaction.reply({ content: `Already claimed by <@${ticket.claimedBy}>.`, ephemeral: true });
          return;
        }
        const nowClaiming = !ticket.claimedBy;
        store.updateTicket(userId, nowClaiming ? { claimedBy: interaction.user.id, claimedByTag: interaction.user.tag } : { claimedBy: null, claimedByTag: null });
        store.appendTranscript(userId, { from: 'system', authorTag: 'System', content: nowClaiming ? `Claimed by ${interaction.user.tag}` : `Unclaimed by ${interaction.user.tag}` });

        const fields = (interaction.message.embeds[0]?.fields || []).map((f) => ({ ...f }));
        const claimIdx = fields.findIndex((f) => f.name === 'Claimed by');
        if (nowClaiming) {
          const claimField = { name: 'Claimed by', value: `<@${interaction.user.id}>`, inline: true };
          if (claimIdx !== -1) fields[claimIdx] = claimField;
          else fields.push(claimField);
        } else if (claimIdx !== -1) {
          fields.splice(claimIdx, 1);
        }
        const embed = EmbedBuilder.from(interaction.message.embeds[0]).setFields(fields);
        await interaction.update({ embeds: [embed], components: [buildTicketActionRow(userId, nowClaiming)] });
        if (interaction.guild) {
          await logEvent(interaction.guild, interaction.client, `${nowClaiming ? '🙋 **Claimed**' : '↩️ **Unclaimed**'} by ${interaction.user.tag} — <#${ticket.channelId}>`);
        }
        return;
      }

      // --- Redirect ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:redirect:')) {
        const userId = interaction.customId.split(':')[2];
        const ticket = store.getTicketByUser(userId);
        if (!ticket) {
          await interaction.reply({ content: 'This ticket is no longer open.', ephemeral: true });
          return;
        }
        const cfg = getConfig();
        const options = cfg.categories
          .filter((c) => c.id !== ticket.categoryId)
          .slice(0, 25)
          .map((c) => ({ label: c.label_en, value: c.id, emoji: c.emoji || undefined }));
        if (!options.length) {
          await interaction.reply({ content: 'No other categories are configured yet.', ephemeral: true });
          return;
        }
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`modmail:redirect_select:${userId}`).setPlaceholder('Choose a category...').addOptions(options),
        );
        await interaction.reply({ content: 'Redirect this ticket to:', components: [row], ephemeral: true });
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('modmail:redirect_select:')) {
        const userId = interaction.customId.split(':')[2];
        const newCategoryId = interaction.values[0];
        const ticket = store.getTicketByUser(userId);
        const newCategory = getCategory(newCategoryId);
        if (!ticket || !newCategory) {
          await interaction.update({ content: 'This ticket or category is no longer available.', components: [] });
          return;
        }
        const oldCategory = getCategory(ticket.categoryId);
        const cfg = getConfig();
        const channel = interaction.guild.channels.cache.get(ticket.channelId);

        if (channel) {
          await channel.permissionOverwrites.set(buildOverwrites(interaction.guild, interaction.client, newCategory));
          const notice = fill(t(cfg, ticket.language || 'en', 'redirectNotice'), {
            from: oldCategory ? oldCategory.label_en : ticket.categoryId,
            to: newCategory.label_en,
            staff: `<@${interaction.user.id}>`,
          });
          await channel.send(notice).catch(() => {});
        }

        store.appendTranscript(userId, {
          from: 'system',
          authorTag: 'System',
          content: `Redirected from ${oldCategory ? oldCategory.label_en : ticket.categoryId} to ${newCategory.label_en} by ${interaction.user.tag}. Ticket unclaimed.`,
        });
        store.updateTicket(userId, { categoryId: newCategoryId, claimedBy: null, claimedByTag: null });

        const updatedTicket = store.getTicketByUser(userId);
        await refreshTicketMessage(interaction.client, interaction.guild, userId, updatedTicket);
        await logEvent(interaction.guild, interaction.client, `🔀 **Redirected** by ${interaction.user.tag} — ${oldCategory ? oldCategory.label_en : ticket.categoryId} → **${newCategory.label_en}** — <#${ticket.channelId}>`);

        await startRedirectQuestionnaire(interaction.client, userId, newCategory, ticket.language || 'en', ticket.channelId);

        await interaction.update({ content: `✅ Redirected to ${newCategory.label_en}. The ticket has been unclaimed.`, components: [] });
        return;
      }

      // --- Post-close rating ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:rate:')) {
        const [, , archiveId, starsStr] = interaction.customId.split(':');
        const stars = parseInt(starsStr, 10);
        archive.setRating(archiveId, { stars, ratedAt: Date.now() });
        const entry = archive.getById(archiveId);
        const lang = entry ? entry.language : 'en';
        const cfg = getConfig();
        const commentRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`modmail:rate_comment:${archiveId}`).setLabel(lang === 'fr' ? 'Ajouter un commentaire' : 'Add a comment').setStyle(ButtonStyle.Secondary),
        );
        await interaction.update({
          content: `${'⭐'.repeat(stars)}\n${t(cfg, lang, 'ratingThanksDM')}\n\n${t(cfg, lang, 'ratingCommentPrompt')}`,
          components: [commentRow],
        });
        if (interaction.guild === null) {
          // This is a DM; find the guild via the archived entry to post a log line.
          const guild = interaction.client.guilds.cache.get(entry?.guildId);
          if (guild) await logEvent(guild, interaction.client, `⭐ **Rating received**: ${stars}/5 from ${entry.userTag} (${entry.categoryLabelEn})`);
        }
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('modmail:rate_comment:')) {
        const archiveId = interaction.customId.split(':')[2];
        const entry = archive.getById(archiveId);
        const lang = entry ? entry.language : 'en';
        const modal = new ModalBuilder().setCustomId(`modmail:rate_comment_modal:${archiveId}`).setTitle(lang === 'fr' ? 'Votre commentaire' : 'Your comment');
        const input = new TextInputBuilder()
          .setCustomId('comment')
          .setLabel(lang === 'fr' ? 'Commentaire (facultatif)' : 'Comment (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('modmail:rate_comment_modal:')) {
        const archiveId = interaction.customId.split(':')[2];
        const comment = interaction.fields.getTextInputValue('comment');
        archive.setRating(archiveId, { comment });
        const entry = archive.getById(archiveId);
        const lang = entry ? entry.language : 'en';
        const cfg = getConfig();
        await interaction.reply({ content: t(cfg, lang, 'ratingThanksDM') });
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
