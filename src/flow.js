const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { MAX_FIELDS_PER_MODAL } = require('./config');

// Finds the next question that should be asked, given the answers collected
// so far. Questions whose showIf condition doesn't match the recorded
// answer are marked as skipped (answers[id] = null) and passed over.
// Mutates `answers` for skip-markers as a side effect.
function nextQuestion(category, answers) {
  for (const q of category.questions || []) {
    if (Object.prototype.hasOwnProperty.call(answers, q.id)) continue; // already answered or skipped
    if (q.showIf) {
      if (!Object.prototype.hasOwnProperty.call(answers, q.showIf.questionId)) {
        // The question this one depends on hasn't been answered yet -
        // not decidable right now, leave it for a later pass.
        continue;
      }
      if (answers[q.showIf.questionId] !== q.showIf.optionId) {
        answers[q.id] = null; // not applicable to this branch
        continue;
      }
    }
    return q;
  }
  return null;
}

// Plans what to show next: either a single "choice" question (select menu),
// a batch of up to 5 consecutive "text" questions (one modal), or "done".
// Does NOT mutate the real answers object - returns an updated copy the
// caller should persist once it has committed to showing that step.
function planNext(category, answers) {
  const working = { ...answers };
  const batch = [];

  while (batch.length < MAX_FIELDS_PER_MODAL) {
    const q = nextQuestion(category, working);
    if (!q) break;
    if (q.type === 'choice') {
      if (batch.length === 0) {
        return { type: 'choice', question: q, answers: working };
      }
      break; // stop the text batch here; the choice will be asked next call
    }
    batch.push(q);
    working[q.id] = '\u0000pending'; // placeholder so the scan moves past it
  }

  if (batch.length) {
    const cleaned = { ...working };
    for (const q of batch) delete cleaned[q.id];
    return { type: 'text', questions: batch, answers: cleaned };
  }

  return { type: 'done', answers: working };
}

function buildChoiceRow(question, lang) {
  const options = (question.options || []).slice(0, 25).map((o) => ({
    label: ((lang === 'fr' ? o.label_fr : o.label_en) || o.id).slice(0, 100),
    value: o.id,
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('modmail:choice')
      .setPlaceholder(lang === 'fr' ? 'Choisir...' : 'Choose...')
      .addOptions(options),
  );
}

function buildModalForBatch(questions, lang, title) {
  const modal = new ModalBuilder().setCustomId('modmail:modal').setTitle((title || 'Details').slice(0, 45));
  for (const q of questions) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(((lang === 'fr' ? q.label_fr : q.label_en) || q.id).slice(0, 45))
      .setStyle(q.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setRequired(q.required !== false)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

module.exports = { nextQuestion, planNext, buildChoiceRow, buildModalForBatch };
