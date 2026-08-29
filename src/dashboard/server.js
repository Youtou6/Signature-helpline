const express = require('express');
const path = require('path');
const { getConfig, saveConfig, slugify } = require('../config');

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
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

  // ---- API ----

  router.get('/api/config', requireAuth, (req, res) => {
    res.json(getConfig());
  });

  router.get('/api/roles', requireAuth, (req, res) => {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return res.json([]);
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id) // exclude @everyone
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
    res.json(roles);
  });

  router.put('/api/settings', requireAuth, express.json(), (req, res) => {
    const cfg = getConfig();
    cfg.settings.teamName = req.body.teamName ?? cfg.settings.teamName;
    saveConfig(cfg);
    res.json(cfg.settings);
  });

  router.post('/api/categories', requireAuth, express.json(), (req, res) => {
    const cfg = getConfig();
    const label = req.body.label_en || 'New Category';
    let id = slugify(label);
    let n = 1;
    while (cfg.categories.some((c) => c.id === id)) {
      id = `${slugify(label)}-${n++}`;
    }
    const category = {
      id,
      emoji: req.body.emoji || '📁',
      label_en: req.body.label_en || 'New Category',
      label_fr: req.body.label_fr || 'Nouvelle catégorie',
      roleIds: Array.isArray(req.body.roleIds) ? req.body.roleIds : [],
      questions: Array.isArray(req.body.questions) && req.body.questions.length
        ? req.body.questions.slice(0, 5)
        : [
            {
              id: 'reason',
              label_en: 'What is the reason for your ticket?',
              label_fr: 'Quelle est la raison de votre ticket ?',
              style: 'paragraph',
              required: true,
            },
          ],
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
      questions: Array.isArray(req.body.questions) ? req.body.questions.slice(0, 5) : existing.questions,
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

  return router;
};
