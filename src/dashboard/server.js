const express = require('express');
const path = require('path');
const { getConfig, saveConfig, slugify, MAX_QUESTIONS_PER_CATEGORY } = require('../config');
const archive = require('../archive');
const store = require('../store');
const bans = require('../bans');
const persistence = require('../persistence');
const { applyPresence } = require('../bot');

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

function sanitizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.slice(0, MAX_QUESTIONS_PER_CATEGORY).map((q, i) => {
    const base = {
      id: q.id || `q-${Date.now().toString(36)}-${i}`,
      type: q.type === 'choice' ? 'choice' : 'text',
      label_en: q.label_en || 'Question',
      label_fr: q.label_fr || 'Question',
      showIf: q.showIf && q.showIf.questionId && q.showIf.optionId ? { questionId: q.showIf.questionId, optionId: q.showIf.optionId } : null,
    };
    if (base.type === 'choice') {
      base.options = Array.isArray(q.options)
        ? q.options.slice(0, 25).map((o, j) => ({
            id: o.id || `opt-${Date.now().toString(36)}-${j}`,
            label_en: o.label_en || 'Option',
            label_fr: o.label_fr || 'Option',
          }))
        : [];
    } else {
      base.style = q.style === 'short' ? 'short' : 'paragraph';
      base.required = q.required !== false;
    }
    return base;
  });
}

module.exports = function dashboardRouter(client) {
  const router = express.Router();

  router.use('/dashboard/assets', express.static(path.join(__dirname, 'public')));

  router.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (req.body.password && req.body.password === process.env.DASHBOARD_PASSWORD) {
      req.session.loggedIn = true;
      return res.redirect('/dashboard');
    }
    return res.redirect('/login?error=1');
  });

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ---- Config: settings ----

  router.get('/api/config', requireAuth, (req, res) => {
    res.json(getConfig());
  });

  router.get('/api/roles', requireAuth, (req, res) => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return res.json([]);
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
    res.json(roles);
  });

  router.put('/api/settings', requireAuth, express.json(), (req, res) => {
    const cfg = getConfig();
    cfg.settings.teamName = req.body.teamName ?? cfg.settings.teamName;
    cfg.settings.pingRoleId = req.body.pingRoleId ?? cfg.settings.pingRoleId;
    cfg.settings.anonymousReplies = req.body.anonymousReplies ?? cfg.settings.anonymousReplies;
    if (req.body.presence) {
      cfg.settings.presence = {
        type: ['PLAYING', 'LISTENING', 'WATCHING', 'COMPETING', 'STREAMING'].includes(req.body.presence.type) ? req.body.presence.type : 'WATCHING',
        text: (req.body.presence.text || '').slice(0, 128),
        url: req.body.presence.url || '',
        status: ['online', 'idle', 'dnd', 'invisible'].includes(req.body.presence.status) ? req.body.presence.status : 'online',
      };
    }
    if (req.body.autoClose) {
      cfg.settings.autoClose = {
        enabled: req.body.autoClose.enabled !== false,
        inactivityHours: Number(req.body.autoClose.inactivityHours) || 24,
        graceMinutes: Number(req.body.autoClose.graceMinutes) || 60,
      };
    }
    saveConfig(cfg);
    applyPresence(client);
    res.json(cfg.settings);
  });

  router.put('/api/texts', requireAuth, express.json(), (req, res) => {
    const cfg = getConfig();
    cfg.settings.texts = { ...cfg.settings.texts, ...req.body };
    saveConfig(cfg);
    res.json(cfg.settings.texts);
  });

  // ---- Config: categories ----

  router.post('/api/categories', requireAuth, express.json(), (req, res) => {
    const cfg = getConfig();
    const label = req.body.label_en || 'New Category';
    let id = slugify(label);
    let n = 1;
    while (cfg.categories.some((c) => c.id === id)) id = `${slugify(label)}-${n++}`;

    const category = {
      id,
      emoji: req.body.emoji || '📁',
      label_en: req.body.label_en || 'New Category',
      label_fr: req.body.label_fr || 'Nouvelle catégorie',
      roleIds: Array.isArray(req.body.roleIds) ? req.body.roleIds : [],
      questions: sanitizeQuestions(req.body.questions).length
        ? sanitizeQuestions(req.body.questions)
        : [{ id: 'reason', type: 'text', label_en: 'What is the reason for your ticket?', label_fr: 'Quelle est la raison de votre ticket ?', style: 'paragraph', required: true, showIf: null }],
    };
    cfg.categories.push(category);
    saveConfig(cfg);
    res.json(category);
  });

  router.put('/api/categories/:id', requireAuth, express.json(), (req, res) => {
    const cfg = getConfig();
    const idx = cfg.categories.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Category not found' });
    const existing = cfg.categories[idx];
    cfg.categories[idx] = {
      ...existing,
      emoji: req.body.emoji ?? existing.emoji,
      label_en: req.body.label_en ?? existing.label_en,
      label_fr: req.body.label_fr ?? existing.label_fr,
      roleIds: Array.isArray(req.body.roleIds) ? req.body.roleIds : existing.roleIds,
      questions: Array.isArray(req.body.questions) ? sanitizeQuestions(req.body.questions) : existing.questions,
    };
    saveConfig(cfg);
    res.json(cfg.categories[idx]);
  });

  router.delete('/api/categories/:id', requireAuth, (req, res) => {
    const cfg = getConfig();
    cfg.categories = cfg.categories.filter((c) => c.id !== req.params.id);
    saveConfig(cfg);
    res.json({ ok: true });
  });

  // ---- Ratings / transcripts ----

  router.get('/api/stats', requireAuth, (req, res) => {
    res.json(archive.getStats());
  });

  router.get('/api/archive', requireAuth, (req, res) => {
    res.json(archive.listSummaries());
  });

  router.get('/api/archive/:id', requireAuth, (req, res) => {
    const entry = archive.getById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  });

  router.delete('/api/archive/:id', requireAuth, (req, res) => {
    const removed = archive.deleteEntry(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ---- Backup: manual export/import + optional GitHub auto-sync status ----

  router.get('/api/backup-status', requireAuth, (req, res) => {
    res.json({ githubSyncEnabled: persistence.isEnabled() });
  });

  router.get('/api/export', requireAuth, (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="signature-modmail-config.json"');
    res.json(getConfig());
  });

  router.post('/api/import', requireAuth, express.json({ limit: '2mb' }), (req, res) => {
    const incoming = req.body;
    if (!incoming || !incoming.settings || !Array.isArray(incoming.categories)) {
      return res.status(400).json({ error: 'This does not look like a valid Signature config export.' });
    }
    saveConfig(incoming);
    applyPresence(client);
    res.json({ ok: true });
  });

  // ---- Open tickets (live, not yet closed) ----

  router.get('/api/tickets', requireAuth, (req, res) => {
    const all = store.readAll();
    const list = Object.entries(all).map(([userId, ticket]) => ({
      userId,
      channelId: ticket.channelId,
      categoryId: ticket.categoryId,
      language: ticket.language,
      openedAt: ticket.openedAt,
      lastActivityAt: ticket.lastActivityAt,
      staffReplied: ticket.staffReplied,
      claimedByTag: ticket.claimedByTag,
    }));
    list.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    res.json(list);
  });

  router.get('/api/tickets/:userId', requireAuth, (req, res) => {
    const ticket = store.getTicketByUser(req.params.userId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    res.json({ userId: req.params.userId, ...ticket });
  });

  router.post('/api/tickets/:userId/note', requireAuth, express.json(), (req, res) => {
    const ticket = store.getTicketByUser(req.params.userId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const author = (req.body.author || 'Dashboard').slice(0, 80);
    const content = (req.body.content || '').slice(0, 1000);
    if (!content.trim()) return res.status(400).json({ error: 'Note cannot be empty' });
    store.appendTranscript(req.params.userId, { from: 'note', authorTag: `${author} (dashboard)`, content });
    res.json({ ok: true });
  });

  router.post('/api/archive/:id/note', requireAuth, express.json(), (req, res) => {
    const entry = archive.getById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const author = (req.body.author || 'Dashboard').slice(0, 80);
    const content = (req.body.content || '').slice(0, 1000);
    if (!content.trim()) return res.status(400).json({ error: 'Note cannot be empty' });
    archive.appendTranscriptEntry(req.params.id, { from: 'note', authorTag: `${author} (dashboard)`, content });
    res.json({ ok: true });
  });

  // ---- Bans ----

  router.get('/api/bans', requireAuth, (req, res) => {
    res.json(bans.listBans());
  });

  router.post('/api/bans', requireAuth, express.json(), (req, res) => {
    const userId = (req.body.userId || '').trim();
    if (!/^\d{5,25}$/.test(userId)) return res.status(400).json({ error: 'That does not look like a valid Discord user ID.' });
    const added = bans.addBan(userId, req.body.reason || '', 'Dashboard');
    if (!added) return res.status(409).json({ error: 'This user is already banned.' });
    res.json({ ok: true });
  });

  router.delete('/api/bans/:userId', requireAuth, (req, res) => {
    const removed = bans.removeBan(req.params.userId);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return router;
};
