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
  PermissionFlagsBits,
  ChannelType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  ActivityType,
} = require('discord.js');

const { getConfig, saveConfig, getCategory } = require('./config');
const store = require('./store');
const archive = require('./archive');
const bans = require('./bans');
const ai = require('./ai');
const { t, fill } = require('./i18n');
const { planNext, buildChoiceRow, buildModalForBatch } = require('./flow');

// In-memory state for users mid-flow (not persisted on purpose: if the bot
// restarts, the user simply gets asked again on their next DM).
const pendingFlows = new Map(); // userId -> { step, lang, categoryId, answers, ..., redirectChannelId? }

const AUTO_CLOSE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RESTART_KEYWORDS = ['restart', 'recommencer', 'annuler', 'cancel', 'reset'];
const MODMAIL_CATEGORY_NAME = 'Modmail Tickets';
const LOG_CHANNEL_NAME = 'modmail-logs';

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

// ---- "Signature" styled messages — plain containers (no accent colour bar, so
// they never read as a disguised embed), no embeds anywhere in this bot. ----

function styledPayload(text, actionRows = []) {
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (actionRows.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    for (const row of actionRows) container.addActionRowComponents(row);
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Signature · Modmail'));
  return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

// Used for DM <-> channel relay messages: a small identity header (avatar + tag) plus the message body.
function relayPayload(tag, avatarURL, content, files) {
  const section = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${tag}**`), new TextDisplayBuilder().setContent(content || '*(no text content)*'))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarURL));
  const container = new ContainerBuilder().addSectionComponents(section);
  return { flags: MessageFlags.IsComponentsV2, components: [container], files: files || [] };
}

function buildLanguageRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modmail:lang:en').setLabel('English').setEmoji('🇬🇧').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modmail:lang:fr').setLabel('Français').setEmoji('🇫🇷').setStyle(ButtonStyle.Secondary),
  );
}

function buildRestartRow(lang) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modmail:restart').setLabel(lang === 'fr' ? '🔄 Recommencer' : '🔄 Restart').setStyle(ButtonStyle.Secondary),
  );
}

function buildContinueRow(lang, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('modmail:continueModal').setLabel(label || (lang === 'fr' ? 'Continuer' : 'Continue')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('modmail:restart').setLabel(lang === 'fr' ? '🔄 Recommencer' : '🔄 Restart').setStyle(ButtonStyle.Secondary),
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

function resetFlowMessage(lang) {
  const cfg = getConfig();
  const resetLine = lang === 'fr' ? '🔄 Processus réinitialisé — vos réponses ont été oubliées.' : '🔄 Process reset — your answers have been forgotten.';
  return styledPayload(`${resetLine}\n\n${t(cfg, 'en', 'welcome')}`, [buildLanguageRow()]);
}

// ---- Permissions / channel discovery helpers ----
// These always try to find an EXISTING "Modmail Tickets" category / log channel by
// name before creating a new one, so a reset config.json (e.g. after a redeploy)
// never causes duplicate categories to pile up on the Discord side.

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

async function findModmailCategory(guild) {
  const cfg = getConfig();
  if (cfg.settings.modmailCategoryId) {
    const existing = guild.channels.cache.get(cfg.settings.modmailCategoryId);
    if (existing) return existing;
  }
  await guild.channels.fetch();
  const byName = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildCategory && ch.name === MODMAIL_CATEGORY_NAME);
  if (byName) {
    cfg.settings.modmailCategoryId = byName.id;
    saveConfig(cfg);
    return byName;
  }
  return null;
}

async function ensureModmailCategory(guild) {
  const found = await findModmailCategory(guild);
  if (found) return found.id;
  const created = await guild.channels.create({ name: MODMAIL_CATEGORY_NAME, type: ChannelType.GuildCategory });
  const cfg = getConfig();
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
  const byName = guild.channels.cache.find((ch) => ch.type === ChannelType.GuildText && ch.name === LOG_CHANNEL_NAME && ch.parentId === parentId);
  if (byName) {
    cfg.settings.logChannelId = byName.id;
    saveConfig(cfg);
    return byName;
  }
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];
  if (cfg.settings.pingRoleId) overwrites.push({ id: cfg.settings.pingRoleId, allow: [PermissionFlagsBits.ViewChannel] });
  const created = await guild.channels.create({
    name: LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
    topic: 'Automatic log of modmail events (tickets opened/closed/redirected/claimed/banned).',
  });
  cfg.settings.logChannelId = created.id;
  saveConfig(cfg);
  return created;
}

async function logEvent(guild, client, content, files) {
  try {
    const channel = await ensureLogChannel(guild, client);
    await channel.send({ content: content.slice(0, 1900), files: files || [] });
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

// ---- The ticket "card" — a real Components V2 container, rebuilt from scratch
// (category/claim/answers) every time something changes, so it's always accurate. ----

function buildTicketContainer(cfg, user, category, lang, answers, claimedBy) {
  const langLabel = lang === 'fr' ? 'Français 🇫🇷' : 'English 🇬🇧';
  const catLabel = lang === 'fr' ? category.label_fr : category.label_en;

  const header = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${t(cfg, lang, 'newTicketChannelIntro')}`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(user.displayAvatarURL()));

  let meta = `**User:** ${user.tag} (\`${user.id}\`)\n**Language:** ${langLabel}\n**Category:** ${catLabel}`;
  if (claimedBy) meta += `\n**Claimed by:** <@${claimedBy}>`;

  const qaBlocks = [];
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
    qaBlocks.push(`**${label}**\n${String(displayValue || '—').slice(0, 900)}`);
  }

  const container = new ContainerBuilder()
    .addSectionComponents(header)
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(meta));

  if (qaBlocks.length) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(qaBlocks.join('\n\n').slice(0, 3900)));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  for (const row of buildTicketActionRows(user.id, !!claimedBy, category)) container.addActionRowComponents(row);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${cfg.settings.teamName}`));

  return container;
}

// Two or three rows: primary actions, secondary/staff-tool actions, and (only when
// this category has the AI enabled) a way to call it in manually.
function buildTicketActionRows(userId, claimed, category) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modmail:close:${userId}`).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`modmail:redirect:${userId}`).setLabel('Redirect').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`modmail:claim:${userId}`)
      .setLabel(claimed ? 'Unclaim' : 'Claim')
      .setEmoji('🙋')
      .setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modmail:remind:${userId}`).setLabel('Remind now').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`modmail:ban:${userId}`).setLabel('Ban user').setEmoji('🚫').setStyle(ButtonStyle.Danger),
  );
  const rows = [row1, row2];
  if (category && category.aiEnabled && ai.isEnabled()) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`modmail:callai:${userId}`).setLabel("Recall L'IA Signature").setEmoji('🤖').setStyle(ButtonStyle.Primary),
      ),
    );
  }
  return rows;
}

async function refreshTicketMessage(client, guild, userId, ticket) {
  const channel = guild.channels.cache.get(ticket.channelId);
  if (!channel || !ticket.ticketMessageId) return;
  const category = getCategory(ticket.categoryId);
  if (!category) return;
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  const cfg = getConfig();
  const container = buildTicketContainer(cfg, user, category, ticket.language || 'en', ticket.answers || {}, ticket.claimedBy);
  const msg = await channel.messages.fetch(ticket.ticketMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] }).catch(() => {});
}

// The channel topic doubles as durable storage for user/category/language,
// so the bot can rebuild its ticket list from Discord itself after a restart
// even if data/tickets.json was reset (e.g. a fresh Render deploy).
function buildTicketTopic(userId, category, lang) {
  return `Signature Modmail | user:${userId} | category:${category.id} | lang:${lang}`;
}

function parseTicketTopic(topic) {
  if (!topic) return null;
  const structured = topic.match(/user:(\d+)\s*\|\s*category:([\w-]+)\s*\|\s*lang:(\w+)/);
  if (structured) return { userId: structured[1], categoryId: structured[2], lang: structured[3] };
  const legacy = topic.match(/\((\d+)\)\s*$/); // older topic format, before this field was added
  if (legacy) return { userId: legacy[1], categoryId: null, lang: 'en' };
  return null;
}

function aiTagFor(lang) {
  return lang === 'fr' ? "🤖 L'IA Signature" : '🤖 Signature AI';
}

async function pingStaffForEscalation(client, guild, channel, category) {
  const cfg = getConfig();
  const pingParts = [...(category.roleIds || [])];
  if (cfg.settings.pingRoleId && !pingParts.includes(cfg.settings.pingRoleId)) pingParts.push(cfg.settings.pingRoleId);
  if (pingParts.length) {
    await channel.send(`${pingParts.map((r) => `<@&${r}>`).join(' ')} — 🔔 this ticket needs a human.`).catch(() => {});
  }
}

async function pingStaffForResolution(client, guild, channel, category) {
  const cfg = getConfig();
  const pingParts = [...(category.roleIds || [])];
  if (cfg.settings.pingRoleId && !pingParts.includes(cfg.settings.pingRoleId)) pingParts.push(cfg.settings.pingRoleId);
  if (pingParts.length) {
    await channel.send(`${pingParts.map((r) => `<@&${r}>`).join(' ')} — ✅ the AI believes this is resolved.`).catch(() => {});
  }
}

// Applies the outcome of an ai.converse() call: sends the reply, logs it, updates
// ticket state, and pings staff on escalation or resolution. Shared by kickoff and
// every subsequent turn so the two paths can never drift out of sync.
async function applyAiResult(client, guild, channel, user, ticket, category, result, history, turnsBefore) {
  const tag = aiTagFor(ticket.language);
  await user.send(relayPayload(tag, client.user.displayAvatarURL(), result.message)).catch(() => {});
  await channel.send(relayPayload(tag, client.user.displayAvatarURL(), result.message)).catch(() => {});
  store.appendTranscript(user.id, { from: 'ai', authorTag: "L'IA Signature", content: result.message });

  store.updateTicket(user.id, {
    aiHistory: [...history, { role: 'model', parts: [{ text: result.message }] }],
    aiTurns: turnsBefore + 1,
  });

  if (result.redirectTo) {
    const targetCategory = getCategory(result.redirectTo);
    if (targetCategory) {
      const freshTicket = store.getTicketByUser(user.id);
      await performRedirect(client, guild, channel, user.id, freshTicket, targetCategory, "🤖 L'IA Signature");
      return;
    }
    // Target category vanished (deleted mid-conversation) - fall through and just keep going normally.
  }

  const cfg = getConfig();
  const maxTurns = (cfg.settings.ai && cfg.settings.ai.maxTurns) || 6;
  const nextTurns = turnsBefore + 1;
  const shouldEscalate = result.escalate || (!result.resolved && nextTurns >= maxTurns);

  store.updateTicket(user.id, { aiActive: !shouldEscalate });

  if (shouldEscalate) {
    store.appendTranscript(user.id, { from: 'system', authorTag: 'System', content: 'Escalated from AI to staff.' });
    await pingStaffForEscalation(client, guild, channel, category);
  } else if (result.resolved) {
    store.appendTranscript(user.id, { from: 'system', authorTag: 'System', content: 'AI marked the issue as resolved.' });
    await pingStaffForResolution(client, guild, channel, category);
  }
}

// Runs once, right after the channel is created, when the category has AI enabled.
// Returns true if the AI actually greeted the user (false = caller should fall back to a normal staff ping).
async function aiKickoff(client, guild, channel, user, category, ticket) {
  const cfg = getConfig();
  const result = await ai.converse(cfg, category, ticket, [], true);
  if (!result) return false;
  await applyAiResult(client, guild, channel, user, ticket, category, result, [], 0);
  return true;
}

// Runs on every subsequent DM from the user while the AI is handling their ticket,
// and also when staff manually re-invoke the AI on a ticket (see "Call AI" button).
// Returns true if the AI handled the message (false = caller should fall back to a normal relay).
async function handleAiUserMessage(client, guild, channel, user, ticket, text) {
  const category = getCategory(ticket.categoryId);
  if (!category) return false;
  const cfg = getConfig();
  const history = [...(ticket.aiHistory || []), { role: 'user', parts: [{ text }] }];
  const result = await ai.converse(cfg, category, ticket, history, false);

  if (!result) {
    store.updateTicket(user.id, { aiActive: false });
    store.appendTranscript(user.id, { from: 'system', authorTag: 'System', content: 'AI unavailable — escalated to staff automatically.' });
    await pingStaffForEscalation(client, guild, channel, category);
    return false;
  }

  await applyAiResult(client, guild, channel, user, ticket, category, result, history, ticket.aiTurns || 0);
  return true;
}

async function createTicketChannel(client, guild, user, category, lang, answers) {
  const parentId = await ensureModmailCategory(guild);
  const cfg = getConfig();
  const useAi = !!category.aiEnabled && ai.isEnabled();

  const channel = await guild.channels.create({
    name: `ticket-${sanitizeChannelName(user.username)}-${shortId()}`,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: buildOverwrites(guild, client, category),
    topic: buildTicketTopic(user.id, category, lang),
  });

  const pingParts = [...(category.roleIds || [])];
  if (cfg.settings.pingRoleId && !pingParts.includes(cfg.settings.pingRoleId)) pingParts.push(cfg.settings.pingRoleId);
  const topComponents = [];
  // If the AI is about to greet the user, hold off on pinging staff - it'll ping when/if it escalates.
  if (pingParts.length && !useAi) topComponents.push(new TextDisplayBuilder().setContent(pingParts.map((r) => `<@&${r}>`).join(' ')));
  topComponents.push(buildTicketContainer(cfg, user, category, lang, answers, null));

  const sentMessage = await channel.send({ flags: MessageFlags.IsComponentsV2, components: topComponents });

  store.createTicket(user.id, {
    channelId: channel.id,
    guildId: guild.id,
    categoryId: category.id,
    language: lang,
    openedAt: Date.now(),
    ticketMessageId: sentMessage.id,
    answers: answers || {},
  });

  store.appendTranscript(user.id, {
    from: 'system',
    authorTag: 'System',
    content: `Ticket opened — category: ${category.label_en}, language: ${lang}.${summarizeAnswers(category, lang, answers) ? `\n${summarizeAnswers(category, lang, answers)}` : ''}`,
  });

  await logEvent(guild, client, `🆕 **New ticket** — ${user.tag} — category **${category.label_en}** — <#${channel.id}>${useAi ? ' 🤖' : ''}`);

  if (useAi) {
    const ticket = store.getTicketByUser(user.id);
    const started = await aiKickoff(client, guild, channel, user, category, ticket);
    if (!started && pingParts.length) {
      // AI didn't respond (e.g. API hiccup) - fall back to the normal ping we skipped above.
      await channel.send(pingParts.map((r) => `<@&${r}>`).join(' ')).catch(() => {});
    }
  }

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
    await interaction.editReply(styledPayload(msg));
    return;
  }

  if (redirectChannelId) {
    const channel = guild.channels.cache.get(redirectChannelId);
    const ticket = store.getTicketByUser(interaction.user.id);
    if (channel && ticket) {
      store.appendTranscript(interaction.user.id, {
        from: 'system',
        authorTag: 'System',
        content: `Redirect questionnaire answered:\n${summarizeAnswers(category, lang, answers)}`,
      });
      store.updateTicket(interaction.user.id, { answers: { ...(ticket.answers || {}), ...answers } });
      const updatedTicket = store.getTicketByUser(interaction.user.id);
      await refreshTicketMessage(interaction.client, guild, interaction.user.id, updatedTicket);
      await channel
        .send(styledPayload(lang === 'fr' ? '📋 Nouvelles réponses reçues — voir le ticket ci-dessus.' : '📋 New questionnaire answers received — see the ticket above.'))
        .catch(() => {});
    }
    pendingFlows.delete(interaction.user.id);
    await interaction.editReply(styledPayload(t(cfg, lang, 'redirectFollowupDoneDM')));
    return;
  }

  await createTicketChannel(interaction.client, guild, interaction.user, category, lang, answers);
  pendingFlows.delete(interaction.user.id);
  await interaction.editReply(styledPayload(t(cfg, lang, 'ticketCreatedDM')));
}

async function presentPlanFromSelect(interaction, plan, categoryId, lang, redirectChannelId) {
  if (plan.type === 'choice') {
    pendingFlows.set(interaction.user.id, { step: 'awaiting_choice', lang, categoryId, answers: plan.answers, currentQuestionId: plan.question.id, redirectChannelId });
    const content = (lang === 'fr' ? plan.question.label_fr : plan.question.label_en) || '...';
    await interaction.update(styledPayload(content, [buildChoiceRow(plan.question, lang), buildRestartRow(lang)]));
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
    await interaction.reply(styledPayload(content, [buildChoiceRow(plan.question, lang), buildRestartRow(lang)]));
    return;
  }
  if (plan.type === 'text') {
    // Discord does not allow chaining a modal directly from a modal submit -
    // ask the user to tap Continue, which is a button interaction and CAN open one.
    pendingFlows.set(interaction.user.id, { step: 'awaiting_continue', lang, categoryId, answers: plan.answers, currentBatchIds: plan.questions.map((q) => q.id), redirectChannelId });
    const promptText = lang === 'fr' ? 'Merci ! Encore quelques questions.' : 'Thanks! A couple more questions.';
    await interaction.reply(styledPayload(promptText, [buildContinueRow(lang)]));
    return;
  }
  await finalizeTicket(interaction, 'reply', categoryId, lang, plan.answers, redirectChannelId);
}

// Shared by the staff "Redirect" flow and the AI's own autonomous redirect
// (when a category has "aiCanRedirect" enabled). Updates permissions/topic,
// posts the notice, unclaims, refreshes the ticket card, logs it, then either
// hands off to the AI in the new category (if it has AI enabled) or asks the
// new category's intake questions like a normal redirect.
async function performRedirect(client, guild, channel, userId, ticket, newCategory, redirectedByLabel) {
  const oldCategory = getCategory(ticket.categoryId);
  const cfg = getConfig();

  await channel.permissionOverwrites.set(buildOverwrites(guild, client, newCategory));
  await channel.setTopic(buildTicketTopic(userId, newCategory, ticket.language || 'en')).catch(() => {});
  const notice = fill(t(cfg, ticket.language || 'en', 'redirectNotice'), {
    from: oldCategory ? oldCategory.label_en : ticket.categoryId,
    to: newCategory.label_en,
    staff: redirectedByLabel,
  });
  await channel.send(notice).catch(() => {});

  store.appendTranscript(userId, {
    from: 'system',
    authorTag: 'System',
    content: `Redirected from ${oldCategory ? oldCategory.label_en : ticket.categoryId} to ${newCategory.label_en} by ${redirectedByLabel}. Ticket unclaimed.`,
  });
  store.updateTicket(userId, { categoryId: newCategory.id, claimedBy: null, claimedByTag: null, aiActive: false });

  const updatedTicket = store.getTicketByUser(userId);
  await refreshTicketMessage(client, guild, userId, updatedTicket);
  await logEvent(guild, client, `🔀 **Redirected** by ${redirectedByLabel} — ${oldCategory ? oldCategory.label_en : ticket.categoryId} → **${newCategory.label_en}** — <#${channel.id}>`);

  const user = await client.users.fetch(userId).catch(() => null);
  if (user && newCategory.aiEnabled && ai.isEnabled()) {
    // Hand off straight to the AI in the new category instead of the static questionnaire.
    const freshTicket = store.getTicketByUser(userId);
    await aiKickoff(client, guild, channel, user, newCategory, freshTicket);
  } else {
    await startRedirectQuestionnaire(client, userId, newCategory, ticket.language || 'en', channel.id);
  }
}

async function startRedirectQuestionnaire(client, userId, newCategory, lang, channelId) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  const cfg = getConfig();
  const plan = planNext(newCategory, {});

  if (plan.type === 'done') {
    await user.send(styledPayload(t(cfg, lang, 'redirectSimpleNoticeDM'))).catch(() => {});
    return;
  }

  const promptText = t(cfg, lang, 'redirectFollowupPromptDM');
  if (plan.type === 'choice') {
    pendingFlows.set(userId, { step: 'awaiting_choice', lang, categoryId: newCategory.id, answers: plan.answers, currentQuestionId: plan.question.id, redirectChannelId: channelId });
    const content = `${promptText}\n\n${lang === 'fr' ? plan.question.label_fr : plan.question.label_en}`;
    await user.send(styledPayload(content, [buildChoiceRow(plan.question, lang)])).catch(() => {});
    return;
  }
  pendingFlows.set(userId, { step: 'awaiting_continue', lang, categoryId: newCategory.id, answers: plan.answers, currentBatchIds: plan.questions.map((q) => q.id), redirectChannelId: channelId });
  await user.send(styledPayload(promptText, [buildContinueRow(lang, lang === 'fr' ? 'Répondre' : 'Answer')])).catch(() => {});
}

// ---- DM intake ----

async function handleNewDM(message) {
  const userId = message.author.id;
  if (pendingFlows.has(userId)) return; // already mid-flow, buttons already sent
  const cfg = getConfig();
  if (bans.isBanned(userId)) {
    await message.channel.send(styledPayload(t(cfg, 'en', 'bannedDM'))).catch(() => {});
    return;
  }
  pendingFlows.set(userId, { step: 'language' });
  await message.channel.send(styledPayload(t(cfg, 'en', 'welcome'), [buildLanguageRow()])).catch(() => {});
}

async function handleRestartCommand(message) {
  const userId = message.author.id;
  const pending = pendingFlows.get(userId);
  const lang = pending?.lang || 'en';
  pendingFlows.delete(userId);
  await message.channel.send(resetFlowMessage(lang)).catch(() => {});
  pendingFlows.set(userId, { step: 'language' });
}

async function handleDM(client, message) {
  const userId = message.author.id;
  const ticket = store.getTicketByUser(userId);

  if (!ticket && RESTART_KEYWORDS.includes(message.content.trim().toLowerCase())) {
    return handleRestartCommand(message);
  }

  if (ticket) {
    const guild = client.guilds.cache.get(ticket.guildId);
    const channel = guild?.channels.cache.get(ticket.channelId);
    if (!channel) {
      store.deleteTicketByUser(userId); // channel deleted manually - clean up and restart
      return handleNewDM(message);
    }
    const files = [...message.attachments.values()].map((a) => ({ attachment: a.url, name: a.name }));

    store.appendTranscript(userId, { from: 'user', authorTag: message.author.tag, content: message.content, attachments: files.map((f) => f.attachment) });
    store.updateTicket(userId, { lastActivityAt: Date.now(), warningSentAt: null });

    // Staff always see what the user wrote, whether or not the AI is currently handling the ticket.
    await channel.send(relayPayload(message.author.tag, message.author.displayAvatarURL(), message.content, files)).catch(() => {});

    if (ticket.aiActive && !files.length) {
      await handleAiUserMessage(client, guild, channel, message.author, ticket, message.content);
    }

    await message.react('✅').catch(() => {});
    return;
  }

  const pending = pendingFlows.get(userId);
  if (pending) {
    const cfg = getConfig();
    await message.channel.send(styledPayload(t(cfg, pending.lang || 'en', 'waitingForButtons'))).catch(() => {});
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

  if (ticket.aiActive) {
    store.updateTicket(ticket.userId, { aiActive: false });
    store.appendTranscript(ticket.userId, { from: 'system', authorTag: 'System', content: `Staff (${message.author.tag}) took over from the AI.` });
  }

  const attachments = [...message.attachments.values()].map((a) => a.url);
  store.appendTranscript(ticket.userId, { from: 'staff', authorTag: message.author.tag, content: message.content, attachments });
  store.updateTicket(ticket.userId, { lastActivityAt: Date.now(), warningSentAt: null, staffReplied: true });

  const user = await message.client.users.fetch(ticket.userId).catch(() => null);
  if (!user) return;

  const cfg = getConfig();
  const displayTag = cfg.settings.anonymousReplies ? cfg.settings.teamName : `${cfg.settings.teamName} — ${message.author.tag}`;
  const files = attachments.map((url) => ({ attachment: url }));
  await user.send(relayPayload(displayTag, message.author.displayAvatarURL(), message.content, files)).catch(async () => {
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
  await user.send(styledPayload(t(cfg, lang, 'ratingRequestDM'), [row]));
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

  if (user && reason !== 'ban') {
    await user.send(styledPayload(t(cfg, ticket.language, 'ticketClosedDM'))).catch(() => {});
    await sendRatingRequest(user, ticket.language || 'en', archiveEntry.id).catch(() => {});
  }
  if (guild) {
    const transcriptText = archive.buildTranscriptText(archiveEntry);
    const logLabel =
      reason === 'auto'
        ? `⏱️ **Auto-closed (inactivity)** — ${archiveEntry.userTag} — category **${archiveEntry.categoryLabelEn}**`
        : reason === 'ban'
          ? `🚫 **Closed (user banned)** by ${closedBy} — ${archiveEntry.userTag} — category **${archiveEntry.categoryLabelEn}**`
          : `🔒 **Ticket closed** by ${closedBy} — ${archiveEntry.userTag} — category **${archiveEntry.categoryLabelEn}**`;
    await logEvent(guild, client, logLabel, [{ attachment: Buffer.from(transcriptText, 'utf8'), name: `transcript-${archiveEntry.id}.txt` }]);
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
            await sendInactivityWarning(client, userId, ticket);
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

// Shared by the automatic 24h scheduler AND the staff "Remind now" button.
async function sendInactivityWarning(client, userId, ticket) {
  const cfg = getConfig();
  const user = await client.users.fetch(userId).catch(() => null);
  if (user) await user.send(styledPayload(t(cfg, ticket.language || 'en', 'inactivityWarningDM'))).catch(() => {});
  store.appendTranscript(userId, { from: 'system', authorTag: 'System', content: 'Inactivity warning sent to the user (auto-close in 1h if no reply).' });
  store.updateTicket(userId, { warningSentAt: Date.now(), staffReplied: true });

  const guild = client.guilds.cache.get(ticket.guildId);
  const channel = guild?.channels.cache.get(ticket.channelId);
  if (channel) {
    await channel
      .send('⏳ *A warning was just sent to the user. This ticket will auto-close in about 1h if they stay silent.*')
      .catch(() => {});
  }
}

// ---- Recovering ticket state after a restart ----

// Best-effort: walk a fetched message's raw V2 component tree and collect every
// text-display string it contains, in order (used to reconstruct old messages).
function extractContainerTexts(message) {
  const texts = [];
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === 'object') {
      if (typeof node.content === 'string') texts.push(node.content);
      if (node.components) walk(node.components);
    }
  }
  walk(message.components);
  return texts;
}

async function reconcileTickets(client) {
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;

    const category = await findModmailCategory(guild);
    if (!category) return; // nothing created yet, nothing to recover
    const cfg = getConfig();

    const ticketChannels = guild.channels.cache.filter(
      (ch) => ch.parentId === category.id && ch.type === ChannelType.GuildText && ch.id !== cfg.settings.logChannelId,
    );

    const known = store.readAll();
    for (const [userId, ticket] of Object.entries(known)) {
      if (!guild.channels.cache.has(ticket.channelId)) store.deleteTicketByUser(userId); // channel deleted while offline
    }

    const stillKnown = store.readAll();
    const knownChannelIds = new Set(Object.values(stillKnown).map((tk) => tk.channelId));
    let recovered = 0;

    for (const channel of ticketChannels.values()) {
      if (knownChannelIds.has(channel.id)) continue;
      const parsed = parseTicketTopic(channel.topic || '');
      if (!parsed) continue;
      const ticketCategory = getCategory(parsed.categoryId) || cfg.categories[0];
      if (!ticketCategory) continue;

      const transcript = [];
      let lastActivityAt = channel.createdTimestamp;
      let ticketMessageId = null;

      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const m of sorted) {
          lastActivityAt = m.createdTimestamp;
          if (m.author.bot) {
            const texts = extractContainerTexts(m);
            if (!ticketMessageId && texts.some((tx) => tx.startsWith('## '))) ticketMessageId = m.id; // the ticket card itself
            const tagMatch = texts[0] && texts[0].match(/^\*\*(.+?)\*\*$/);
            if (tagMatch) {
              transcript.push({ at: m.createdTimestamp, from: 'user', authorTag: tagMatch[1], content: texts.slice(1).join('\n') });
            } else if (texts.length) {
              transcript.push({ at: m.createdTimestamp, from: 'system', authorTag: 'System', content: texts.join('\n').slice(0, 1800) });
            }
            continue;
          }
          if (m.content.startsWith('!')) {
            transcript.push({ at: m.createdTimestamp, from: 'note', authorTag: m.author.tag, content: m.content.slice(1).trim() });
          } else {
            transcript.push({ at: m.createdTimestamp, from: 'staff', authorTag: m.author.tag, content: m.content });
          }
        }
      } catch (err) {
        console.error('Ticket recovery: could not fetch message history for', channel.id, err.message || err);
      }

      store.createTicket(parsed.userId, {
        channelId: channel.id,
        guildId: guild.id,
        categoryId: ticketCategory.id,
        language: parsed.lang || 'en',
        openedAt: channel.createdTimestamp,
        ticketMessageId,
        claimedBy: null,
        claimedByTag: null,
        staffReplied: false, // safest default - avoids an unexpected auto-close right after recovery
        lastActivityAt,
        warningSentAt: null,
        transcript,
        answers: {}, // original Q&A values aren't recoverable from the container text alone
      });
      recovered++;
    }

    if (recovered > 0) {
      console.log(`Signature Modmail — recovered ${recovered} ticket(s) after restart.`);
      await logEvent(guild, client, `♻️ **Bot restarted** — recovered ${recovered} open ticket(s) from existing channels.`);
    }
  } catch (err) {
    console.error('reconcileTickets error:', err);
  }
}

// ---- Presence (bot status) ----

function activityTypeFromString(type) {
  const map = {
    PLAYING: ActivityType.Playing,
    LISTENING: ActivityType.Listening,
    WATCHING: ActivityType.Watching,
    COMPETING: ActivityType.Competing,
    STREAMING: ActivityType.Streaming,
  };
  return map[type] ?? ActivityType.Watching;
}

function applyPresence(client) {
  try {
    if (!client.user) return;
    const cfg = getConfig();
    const presence = cfg.settings.presence || {};
    const activity = { name: presence.text || 'Signature', type: activityTypeFromString(presence.type) };
    if (presence.type === 'STREAMING') activity.url = presence.url || 'https://twitch.tv/discord';
    client.user.setPresence({ activities: [activity], status: presence.status || 'online' });
  } catch (err) {
    console.error('applyPresence error:', err);
  }
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

  client.once('ready', async () => {
    console.log(`Signature Modmail — logged in as ${client.user.tag}`);
    applyPresence(client);
    await reconcileTickets(client);
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
      // --- Restart (available from every step of the intake flow) ---
      if (interaction.isButton() && interaction.customId === 'modmail:restart') {
        const pending = pendingFlows.get(interaction.user.id);
        const lang = pending?.lang || 'en';
        pendingFlows.delete(interaction.user.id);
        pendingFlows.set(interaction.user.id, { step: 'language' });
        await interaction.update(resetFlowMessage(lang));
        return;
      }

      // --- Language & category intake ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:lang:')) {
        const lang = interaction.customId.split(':')[2];
        pendingFlows.set(interaction.user.id, { step: 'category', lang });
        const cfg = getConfig();
        await interaction.update(styledPayload(t(cfg, lang, 'chooseCategory'), [buildCategorySelect(lang), buildRestartRow(lang)]));
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

      // --- Remind now (manually trigger the inactivity warning) ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:remind:')) {
        const userId = interaction.customId.split(':')[2];
        const ticket = store.getTicketByUser(userId);
        if (!ticket) {
          await interaction.reply({ content: 'This ticket is no longer open.', ephemeral: true });
          return;
        }
        await sendInactivityWarning(interaction.client, userId, ticket);
        await interaction.reply({ content: '⏳ Reminder sent to the user — auto-close in ~1h if they stay silent.', ephemeral: true });
        if (interaction.guild) await logEvent(interaction.guild, interaction.client, `⏳ **Manual reminder** sent by ${interaction.user.tag} — <#${ticket.channelId}>`);
        return;
      }

      // --- Manually call the AI into a ticket (category must have it enabled) ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:callai:')) {
        const userId = interaction.customId.split(':')[2];
        const ticket = store.getTicketByUser(userId);
        if (!ticket) {
          await interaction.reply({ content: 'This ticket is no longer open.', ephemeral: true });
          return;
        }
        const category = getCategory(ticket.categoryId);
        if (!category || !category.aiEnabled || !ai.isEnabled()) {
          await interaction.reply({ content: "L'IA is not available for this category.", ephemeral: true });
          return;
        }
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        const channel = interaction.guild?.channels.cache.get(ticket.channelId);
        if (!user || !channel) {
          await interaction.reply({ content: 'Something went wrong, please try again.', ephemeral: true });
          return;
        }
        await interaction.reply({ content: "🤖 Calling L'IA Signature into this ticket...", ephemeral: true });
        store.updateTicket(userId, { aiActive: true });
        const freshTicket = store.getTicketByUser(userId);
        if (freshTicket.aiHistory && freshTicket.aiHistory.length) {
          await handleAiUserMessage(
            interaction.client,
            interaction.guild,
            channel,
            user,
            freshTicket,
            '(Staff just re-enabled you on this ticket. Briefly check in with the user and continue helping - do not repeat your introduction.)',
          );
        } else {
          await aiKickoff(interaction.client, interaction.guild, channel, user, category, freshTicket);
        }
        if (interaction.guild) await logEvent(interaction.guild, interaction.client, `🤖 **AI called in manually** by ${interaction.user.tag} — <#${ticket.channelId}>`);
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

        const updatedTicket = store.getTicketByUser(userId);
        const category = getCategory(updatedTicket.categoryId);
        const user = await interaction.client.users.fetch(userId).catch(() => null);
        if (category && user) {
          const cfg = getConfig();
          const container = buildTicketContainer(cfg, user, category, updatedTicket.language || 'en', updatedTicket.answers || {}, updatedTicket.claimedBy);
          await interaction.update({ flags: MessageFlags.IsComponentsV2, components: [container] });
        } else {
          await interaction.deferUpdate();
        }
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
        const channel = interaction.guild.channels.cache.get(ticket.channelId);
        if (!channel) {
          await interaction.update({ content: 'This channel no longer exists.', components: [] });
          return;
        }

        await performRedirect(interaction.client, interaction.guild, channel, userId, ticket, newCategory, `<@${interaction.user.id}>`);

        await interaction.update({ content: `✅ Redirected to ${newCategory.label_en}. The ticket has been unclaimed.`, components: [] });
        return;
      }

      // --- Ban (with confirmation) ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:ban:')) {
        const userId = interaction.customId.split(':')[2];
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`modmail:ban_confirm:${userId}`).setLabel('Confirm ban & close').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('modmail:ban_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        );
        await interaction.reply({ content: `⚠️ Ban <@${userId}> from opening new tickets, and close this one?`, components: [confirmRow], ephemeral: true });
        return;
      }

      if (interaction.isButton() && interaction.customId === 'modmail:ban_cancel') {
        await interaction.update({ content: 'Cancelled.', components: [] });
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('modmail:ban_confirm:')) {
        const userId = interaction.customId.split(':')[2];
        const added = bans.addBan(userId, `Banned via ticket by ${interaction.user.tag}`, interaction.user.tag);
        const ticket = store.getTicketByUser(userId);
        if (ticket) await closeTicket(interaction.client, userId, interaction.user.tag, 'ban');
        await interaction.update({ content: added ? `🚫 <@${userId}> has been banned and the ticket closed.` : `<@${userId}> was already banned. Ticket closed.`, components: [] });
        if (interaction.guild) await logEvent(interaction.guild, interaction.client, `🚫 **User banned** by ${interaction.user.tag} — <@${userId}>`);
        return;
      }

      // --- Post-close rating ---
      if (interaction.isButton() && interaction.customId.startsWith('modmail:rate:')) {
        const [, , archiveId, starsStr] = interaction.customId.split(':');
        const stars = parseInt(starsStr, 10);
        archive.setRating(archiveId, { stars, ratedAt: Date.now() });
        archive.appendTranscriptEntry(archiveId, { from: 'system', authorTag: 'System', content: `User rated the support ${stars}/5.` });
        const entry = archive.getById(archiveId);
        const lang = entry ? entry.language : 'en';
        const cfg = getConfig();
        const commentRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`modmail:rate_comment:${archiveId}`).setLabel(lang === 'fr' ? 'Ajouter un commentaire' : 'Add a comment').setStyle(ButtonStyle.Secondary),
        );
        await interaction.update(styledPayload(`${'⭐'.repeat(stars)}\n${t(cfg, lang, 'ratingThanksDM')}\n\n${t(cfg, lang, 'ratingCommentPrompt')}`, [commentRow]));
        if (entry) {
          const guild = interaction.client.guilds.cache.get(entry.guildId);
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
        if (comment) archive.appendTranscriptEntry(archiveId, { from: 'system', authorTag: 'System', content: `User comment: ${comment}` });
        const entry = archive.getById(archiveId);
        const lang = entry ? entry.language : 'en';
        const cfg = getConfig();
        await interaction.reply(styledPayload(t(cfg, lang, 'ratingThanksDM')));
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

module.exports = { createBotClient, closeTicket, applyPresence };
