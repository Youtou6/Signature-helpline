const express = require('express');
const path = require('path');
const { getConfig, saveConfig, slugify, MAX_QUESTIONS_PER_CATEGORY } = require('../config');
const archive = require('../archive');

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
    if (req.body.autoClose) {
      cfg.settings.autoClose = {
        enabled: req.body.autoClose.enabled !== false,
        inactivityHours: Number(req.body.autoClose.inactivityHours) || 24,
        graceMinutes: Number(req.body.autoClose.graceMinutes) || 60,
      };
    }
    saveConfig(cfg);
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

  return router;
};
