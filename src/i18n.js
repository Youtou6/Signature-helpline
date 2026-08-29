const { DEFAULT_TEXTS } = require('./config');

// Reads a bilingual UI string from the live config (dashboard-editable),
// falling back to the built-in default if it's ever missing.
// key examples: 'chooseCategory', 'ticketCreatedDM', 'ratingRequestDM'...
// 'welcome' has no _en/_fr suffix (shown before the language is even picked).
function t(cfg, lang, key) {
  const texts = (cfg && cfg.settings && cfg.settings.texts) || {};
  if (key === 'welcome') {
    return texts.welcome || DEFAULT_TEXTS.welcome;
  }
  const l = lang === 'fr' ? 'fr' : 'en';
  const fullKey = `${key}_${l}`;
  return texts[fullKey] || DEFAULT_TEXTS[fullKey] || key;
}

function fill(str, vars) {
  return Object.entries(vars || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), str);
}

module.exports = { t, fill, DEFAULT_TEXTS };
