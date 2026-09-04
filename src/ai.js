// "L'IA Signature" - an optional first-line AI assistant, powered by Google's
// Gemini API (it has a genuinely free tier, see README). Entirely inert if
// GEMINI_API_KEY isn't set - isEnabled() gates every call site.
//
// Gemini's Google Search grounding cannot be combined with structured JSON
// output in the same request (this is a hard API limitation, not a bug on
// our side). So when the assistant wants to search the web, this module runs
// a small two-step dance: (1) a normal JSON-mode turn that may ask to search,
// (2) if so, a separate plain-text, search-grounded request to gather
// findings, then (3) one more JSON-mode turn fed those findings to produce
// the actual reply. All of this is invisible to bot.js - converse() always
// returns the same simple shape.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = 'gemini-3.6-flash';

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

function listOtherCategoriesForPrompt(cfg, currentCategoryId) {
  return cfg.categories
    .filter((c) => c.id !== currentCategoryId)
    .map((c) => `- id: "${c.id}" — ${c.label_en}`)
    .join('\n');
}

function buildSystemPrompt(cfg, category, ticket) {
  const teamName = cfg.settings.teamName || 'Signature Support';
  const lang = ticket.language === 'fr' ? 'French' : 'English';
  const answers = summarizeAnswersForPrompt(category, ticket.language, ticket.answers);
  const knowledge = (category.aiKnowledge || '').trim();

  const lines = [
    `You are "L'IA Signature" (in English: "Signature AI"), the first-line automated assistant for ${teamName}'s support team on Discord.`,
    `Always reply in ${lang}, matching the user's language, regardless of what language this prompt is written in.`,
    `Introduce yourself once, right at the start of the very first message of the conversation, as "L'IA Signature" (French) or "Signature AI" (English) as appropriate. Never re-introduce yourself after that.`,
    ``,
    `Support category: ${category.label_en}`,
    `The user already answered these intake questions when opening the ticket:`,
    answers || '(no additional answers were collected)',
    ``,
    `Staff-provided knowledge for this category — treat this as ground truth about real, known causes and solutions, and lean on it heavily when diagnosing the issue:`,
    knowledge || '(no special knowledge was provided for this category — rely on general good judgment, and search or escalate more readily)',
    ``,
    `Your job: ask focused, specific diagnostic questions one at a time (don't dump a long checklist at once), and offer concrete solutions grounded in the knowledge above. Keep the "Signature" tone: warm, precise, no corporate fluff, no filler.`,
    ``,
    `You always have a way to bring in a human — never make the user feel stuck. Use status "escalate" (and say so kindly in "message", e.g. that a team member is joining shortly) whenever ANY of these happen:`,
    `- the user explicitly asks to talk to a human / a real person / staff,`,
    `- you don't have enough knowledge to help even after trying to search,`,
    `- the topic is sensitive (payments, harassment, account security, legal),`,
    `- the user is being abusive, is trolling, or the conversation is clearly unproductive,`,
    `- you've exchanged several messages without real progress.`,
    `Use status "resolved" when you're confident the issue is genuinely fixed — still write a normal closing reply in "message" (e.g. confirming the fix and inviting them to write again if it comes back).`,
    `Use status "search" ONLY when the question is specifically about Roblox Studio / Roblox development, the answer isn't in the knowledge above or your own knowledge, and a quick look at the Roblox Developer Forum or official Roblox documentation would likely help. Leave "message" empty and set "searchQuery" to a focused, English search query. You will then be given research findings and asked to answer again — never invent an answer you're not sure of instead of searching.`,
  ];

  if (category.aiCanRedirect) {
    const others = listOtherCategoriesForPrompt(cfg, category.id);
    lines.push(
      ``,
      `This ticket was opened under "${category.label_en}", but if the user's actual issue is clearly a better fit for a different category, you can send it there directly instead of continuing here. Available categories to redirect to:`,
      others || '(no other categories are configured)',
      `Use status "redirect" when the category is clearly wrong — not for minor overlaps, only when it plainly belongs elsewhere. Set "targetCategoryId" to the exact id from the list above, and use "message" to let the user know, warmly, that you're sending them to the right place (do not ask a follow-up question in that same message).`,
    );
  }

  lines.push(
    `Otherwise use status "continue" for a normal reply that keeps the conversation going.`,
    ``,
    `Respond ONLY with a single JSON object of this exact shape, no markdown fences, nothing else before or after it:`,
    `{"status": "continue" | "resolved" | "escalate" | "search"${category.aiCanRedirect ? ' | "redirect"' : ''}, "message": "your reply to the user, in their language (empty string if status is search)", "searchQuery": "only set when status is search, else empty string"${category.aiCanRedirect ? ', "targetCategoryId": "only set when status is redirect, else empty string"' : ''}}`,
  );

  return lines.join('\n');
}

async function callModel(cfg, model, contents, systemPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      console.error('Gemini API error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
    if (!raw) return null;
    try {
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '');
      const parsed = JSON.parse(cleaned);
      return {
        status: ['continue', 'resolved', 'escalate', 'search', 'redirect'].includes(parsed.status) ? parsed.status : 'continue',
        message: String(parsed.message || ''),
        searchQuery: String(parsed.searchQuery || ''),
        targetCategoryId: String(parsed.targetCategoryId || ''),
      };
    } catch (parseErr) {
      console.error('Gemini response was not valid JSON, escalating as a safety fallback:', parseErr.message, raw);
      return { status: 'escalate', message: raw.slice(0, 1800), searchQuery: '', targetCategoryId: '' };
    }
  } catch (err) {
    console.error('Gemini request failed:', err.message || err);
    return null;
  }
}

// Separate, non-JSON, search-grounded request. Returns a short text summary,
// or null if search failed / found nothing usable (never throws).
async function searchWeb(cfg, query) {
  const model = (cfg.settings.ai && cfg.settings.ai.model) || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Search the web — prioritize the Roblox Developer Forum (devforum.roblox.com) and official Roblox documentation (create.roblox.com/docs) when relevant — and give a concise, factual summary (max ~150 words) to help answer this Roblox support question: ${query}`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      console.error('Gemini search error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(' ').trim();
    if (!text || text.length < 20) return null; // defensive: known issue where grounded responses can come back truncated/empty
    return text.slice(0, 1500);
  } catch (err) {
    console.error('Gemini search request failed:', err.message || err);
    return null;
  }
}

async function converse(cfg, category, ticket, history, isKickoff) {
  if (!isEnabled()) return null;
  const model = (cfg.settings.ai && cfg.settings.ai.model) || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt(cfg, category, ticket);

  const contents = isKickoff
    ? [{ role: 'user', parts: [{ text: 'The ticket has just been created. Greet the user and begin helping them based on the context above.' }] }]
    : history;

  let result = await callModel(cfg, model, contents, systemPrompt);
  if (!result) return null;

  if (result.status === 'search' && result.searchQuery) {
    const findings = await searchWeb(cfg, result.searchQuery);
    if (findings) {
      const followUpContents = [
        ...contents,
        { role: 'model', parts: [{ text: `(internal research note, not visible to the user, about "${result.searchQuery}": ${findings})` }] },
        { role: 'user', parts: [{ text: '(Please now answer using that research, in the required JSON format.)' }] },
      ];
      const followUp = await callModel(cfg, model, followUpContents, systemPrompt);
      result = followUp && followUp.status !== 'search' ? followUp : null;
    } else {
      result = null;
    }
    if (!result) {
      result = {
        status: 'continue',
        message:
          ticket.language === 'fr'
            ? "Je n'ai pas trouvé d'information fiable là-dessus pour l'instant — pouvez-vous préciser votre question ou reformuler ?"
            : "I couldn't find reliable information on that just now — could you clarify or rephrase your question?",
      };
    }
  }

  return {
    escalate: result.status === 'escalate',
    resolved: result.status === 'resolved',
    redirectTo: result.status === 'redirect' ? result.targetCategoryId || null : null,
    message: String(result.message || '').slice(0, 1800),
  };
}

module.exports = { isEnabled, converse, DEFAULT_MODEL };
