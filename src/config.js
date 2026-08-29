const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const MAX_QUESTIONS_PER_CATEGORY = 10;
const MAX_FIELDS_PER_MODAL = 5;

const DEFAULT_TEXTS = {
  welcome:
    '**Welcome to Signature.** / **Bienvenue sur Signature.**\nPlease choose your language to continue. / Merci de choisir votre langue pour continuer.',
  chooseCategory_en: 'Thank you! Please select the type of support you need below.',
  chooseCategory_fr: 'Merci ! Merci de sélectionner le type de support souhaité ci-dessous.',
  ticketCreatedDM_en:
    '✅ **Your ticket has been created.** Our staff will get back to you here as soon as possible. You can keep sending messages or attachments in this DM at any time — they will be forwarded automatically.',
  ticketCreatedDM_fr:
    "✅ **Votre ticket a été créé.** Notre équipe vous répondra ici dès que possible. Vous pouvez continuer à envoyer des messages ou des pièces jointes dans ce message privé à tout moment — ils seront transmis automatiquement.",
  ticketClosedDM_en:
    '🔒 **Your ticket has been closed.** Thank you for contacting Signature. Feel free to send a new message here at any time to open another ticket.',
  ticketClosedDM_fr:
    "🔒 **Votre ticket a été fermé.** Merci d'avoir contacté Signature. N'hésitez pas à envoyer un nouveau message ici à tout moment pour ouvrir un autre ticket.",
  waitingForButtons_en: 'Please use the buttons/menu above to continue — free text is not needed at this step.',
  waitingForButtons_fr: "Merci d'utiliser les boutons/menu ci-dessus pour continuer — inutile d'écrire un message à cette étape.",
  modalTitle_en: 'A few last details',
  modalTitle_fr: 'Quelques derniers détails',
  newTicketChannelIntro_en: 'New modmail ticket',
  newTicketChannelIntro_fr: 'Nouveau ticket modmail',
  inactivityWarningDM_en:
    "⏳ Your ticket has been quiet for a while. If we don't hear back from you, it will be **automatically closed in 1 hour**. Just reply here to keep it open.",
  inactivityWarningDM_fr:
    "⏳ Votre ticket est inactif depuis un moment. Si nous n'avons pas de nouvelles, il sera **automatiquement fermé dans 1 heure**. Répondez simplement ici pour le garder ouvert.",
  ratingRequestDM_en: 'How would you rate the support you received? (optional)',
  ratingRequestDM_fr: "Comment évalueriez-vous le support reçu ? (facultatif)",
  ratingThanksDM_en: '🙏 Thanks for your feedback!',
  ratingThanksDM_fr: '🙏 Merci pour votre retour !',
  ratingCommentPrompt_en: 'Want to add a comment? (optional)',
  ratingCommentPrompt_fr: 'Voulez-vous ajouter un commentaire ? (facultatif)',
  redirectNotice_en: '🔀 This ticket was redirected from **{from}** to **{to}** by {staff}.',
  redirectNotice_fr: '🔀 Ce ticket a été redirigé de **{from}** vers **{to}** par {staff}.',
};

function defaultConfig() {
  return {
    settings: {
      teamName: 'Signature Support',
      modmailCategoryId: '',
      logChannelId: '',
      autoClose: {
        enabled: true,
        inactivityHours: 24,
        graceMinutes: 60,
      },
      texts: { ...DEFAULT_TEXTS },
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
            type: 'text',
            label_en: 'What is the technical issue you need help with?',
            label_fr: "Quel est le problème technique pour lequel vous avez besoin d'aide ?",
            style: 'paragraph',
            required: true,
            showIf: null,
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
            type: 'text',
            label_en: 'What is your question?',
            label_fr: 'Quelle est votre question ?',
            style: 'paragraph',
            required: true,
            showIf: null,
          },
        ],
      },
      {
        id: 'custom',
        emoji: '✨',
        label_en: 'Custom Services',
        label_fr: 'Services custom',
        roleIds: [],
        questions: [
          {
            id: 'service_type',
            type: 'choice',
            label_en: 'What service are you interested in?',
            label_fr: 'Quel service vous intéresse ?',
            showIf: null,
            options: [
              { id: 'logo', label_en: 'Logo design', label_fr: 'Création de logo' },
              { id: 'website', label_en: 'Website', label_fr: 'Site web' },
              { id: 'other', label_en: 'Something else', label_fr: 'Autre chose' },
            ],
          },
          {
            id: 'logo_style',
            type: 'text',
            label_en: 'What style are you looking for?',
            label_fr: 'Quel style recherchez-vous ?',
            style: 'paragraph',
            required: true,
            showIf: { questionId: 'service_type', optionId: 'logo' },
          },
          {
            id: 'website_pages',
            type: 'text',
            label_en: 'Roughly how many pages should the site have?',
            label_fr: 'Combien de pages le site doit-il avoir environ ?',
            style: 'short',
            required: true,
            showIf: { questionId: 'service_type', optionId: 'website' },
          },
          {
            id: 'other_details',
            type: 'text',
            label_en: 'Please describe what you need.',
            label_fr: 'Merci de décrire ce dont vous avez besoin.',
            style: 'paragraph',
            required: true,
            showIf: { questionId: 'service_type', optionId: 'other' },
          },
          {
            id: 'budget',
            type: 'text',
            label_en: 'What is your budget?',
            label_fr: 'Quel est votre budget ?',
            style: 'short',
            required: true,
            showIf: null,
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
            type: 'text',
            label_en: 'Please describe the reason for your ticket.',
            label_fr: 'Merci de décrire la raison de votre ticket.',
            style: 'paragraph',
            required: true,
            showIf: null,
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

function migrate(cfg) {
  // Fill in any settings/keys added after this install was first created, so
  // older data/config.json files on disk keep working after an update.
  cfg.settings = cfg.settings || {};
  cfg.settings.autoClose = { enabled: true, inactivityHours: 24, graceMinutes: 60, ...(cfg.settings.autoClose || {}) };
  cfg.settings.texts = { ...DEFAULT_TEXTS, ...(cfg.settings.texts || {}) };
  cfg.categories = cfg.categories || [];
  return cfg;
}

function getConfig() {
  ensureConfig();
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return migrate(cfg);
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
  return (
    String(text)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 32) || `cat-${Date.now().toString(36)}`
  );
}

module.exports = {
  getConfig,
  saveConfig,
  defaultConfig,
  getCategory,
  slugify,
  CONFIG_PATH,
  DEFAULT_TEXTS,
  MAX_QUESTIONS_PER_CATEGORY,
  MAX_FIELDS_PER_MODAL,
};
