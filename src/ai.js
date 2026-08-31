// "L'IA Signature" - an optional first-line AI assistant, powered by Google's
// Gemini API (it has a genuinely free tier, see README). Entirely inert if
// GEMINI_API_KEY isn't set - isEnabled() gates every call site.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = 'gemini-2.5-flash';

function isEnabled() {
  return Boolean(GEMINI_API_KEY);
}

function summarizeAnswersForPrompt(category, lang, answers) {
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
    lines.push(`- ${label}: ${displayValue}`);
  }
  return lines.join('\n');
}

function buildSystemPrompt(cfg, category, ticket) {
  const teamName = cfg.settings.teamName || 'Signature Support';
  const lang = ticket.language === 'fr' ? 'French' : 'English';
  const answers = summarizeAnswersForPrompt(category, ticket.language, ticket.answers);
  const knowledge = (category.aiKnowledge || '').trim();

  return [
    `You are "L'IA Signature" (in English: "Signature AI"), the first-line automated assistant for ${teamName}'s support team on Discord.`,
    `Always reply in ${lang}, matching the user's language, regardless of what language this prompt is written in.`,
    `Introduce yourself once, right at the start of the very first message of the conversation, as "L'IA Signature" (French) or "Signature AI" (English) as appropriate. Never re-introduce yourself after that.`,
    ``,
    `Support category: ${category.label_en}`,
    `The user already answered these intake questions when opening the ticket:`,
    answers || '(no additional answers were collected)',
    ``,
    `Staff-provided knowledge for this category — treat this as ground truth about real, known causes and solutions, and lean on it heavily when diagnosing the issue:`,
    knowledge || '(no special knowledge was provided for this category — rely on general good judgment, and escalate more readily)',
    ``,
    `Your job: ask focused, specific diagnostic questions one at a time (don't dump a long checklist at once), and offer concrete solutions grounded in the knowledge above. Keep the "Signature" tone: warm, precise, no corporate fluff, no filler.`,
    `If the issue looks resolved, say so plainly and let the user know they can just send another message any time if it comes back.`,
    `Set "escalate" to true (and say so kindly in "message") if: the knowledge above doesn't cover the situation, the user explicitly asks for a human, the topic is sensitive (payments, harassment, legal), or you've already exchanged several messages without making progress.`,
    ``,
    `Respond ONLY with a single JSON object of this exact shape, no markdown fences, nothing else before or after it:`,
    `{"escalate": boolean, "message": "your reply to the user, in their language"}`,
  ].join('\n');
}

async function converse(cfg, category, ticket, history, isKickoff) {
  if (!isEnabled()) return null;
  const model = (cfg.settings.ai && cfg.settings.ai.model) || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const contents = isKickoff
    ? [{ role: 'user', parts: [{ text: 'The ticket has just been created. Greet the user and begin helping them based on the context above.' }] }]
    : history;

  const body = {
    contents,
    systemInstruction: { parts: [{ text: buildSystemPrompt(cfg, category, ticket) }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
  };

  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      console.error('Gemini API error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
      const parsed = JSON.parse(cleaned);
      return { escalate: !!parsed.escalate, message: String(parsed.message || '').slice(0, 1800) };
    } catch (parseErr) {
      console.error('Gemini response was not valid JSON, escalating as a safety fallback:', parseErr.message, raw);
      return { escalate: true, message: raw.slice(0, 1800) };
    }
  } catch (err) {
    console.error('Gemini request failed:', err.message || err);
    return null;
  }
}

module.exports = { isEnabled, converse, DEFAULT_MODEL };
