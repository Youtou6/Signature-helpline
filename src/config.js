const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function defaultConfig() {
  return {
    settings: {
      teamName: 'Signature Support',
      modmailCategoryId: '',
      logChannelId: '',
    },
    categories: [
      {
        id: 'technical',
        emoji: '🛠️',
        label_en: 'Technical Support',
        label_fr: 'Support technique',
        roleIds: [],
        questions: [
          {
            id: 'reason',
            label_en: 'What is the technical issue you need help with?',
            label_fr: "Quel est le problème technique pour lequel vous avez besoin d'aide ?",
            style: 'paragraph',
            required: true,
          },
        ],
      },
      {
        id: 'question',
        emoji: '❓',
        label_en: 'Question',
        label_fr: 'Question',
        roleIds: [],
        questions: [
          {
            id: 'reason',
            label_en: 'What is your question?',
            label_fr: 'Quelle est votre question ?',
            style: 'paragraph',
            required: true,
          },
        ],
      },
      {
        id: 'other',
        emoji: '📁',
        label_en: 'Other',
        label_fr: 'Autre',
        roleIds: [],
        questions: [
          {
            id: 'reason',
            label_en: 'Please describe the reason for your ticket.',
            label_fr: 'Merci de décrire la raison de votre ticket.',
            style: 'paragraph',
            required: true,
          },
        ],
      },
    ],
  };
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2));
  }
}

function getConfig() {
  ensureConfig();
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

function getCategory(id) {
  const cfg = getConfig();
  return cfg.categories.find((c) => c.id === id) || null;
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32) || `cat-${Date.now().toString(36)}`;
}

module.exports = {
  getConfig,
  saveConfig,
  defaultConfig,
  getCategory,
  slugify,
  CONFIG_PATH,
};
