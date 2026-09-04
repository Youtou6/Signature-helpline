(function () {
  let roles = [];
  let config = { settings: {}, categories: [] };

  const categoryListEl = document.getElementById('categoryList');
  const categoryTpl = document.getElementById('categoryTemplate');
  const questionTpl = document.getElementById('questionTemplate');
  const optionTpl = document.getElementById('optionTemplate');

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async function api(path, opts) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  }

  function flashSaved(el) {
    el.hidden = false;
    setTimeout(() => (el.hidden = true), 1800);
  }

  // ---- Tabs ----
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = true));
        btn.classList.add('active');
        document.querySelector(`[data-tab-panel="${btn.dataset.tab}"]`).hidden = false;
        if (btn.dataset.tab === 'reviews') loadReviews();
        if (btn.dataset.tab === 'tickets') loadOpenTickets();
        if (btn.dataset.tab === 'bans') loadBans();
      });
    });
  }

  // ---- Roles picker ----
  function buildRolesPicker(container, selectedIds) {
    container.innerHTML = '';
    if (!roles.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Aucun rôle trouvé — vérifie que GUILD_ID est correct et que le bot est bien sur ton serveur.';
      container.appendChild(p);
      return;
    }
    for (const role of roles) {
      const label = document.createElement('label');
      label.className = 'role-chip' + (selectedIds.includes(role.id) ? ' active' : '');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = role.id;
      input.checked = selectedIds.includes(role.id);
      input.addEventListener('change', () => label.classList.toggle('active', input.checked));
      label.appendChild(input);
      label.appendChild(document.createTextNode(role.name));
      container.appendChild(label);
    }
  }

  // ---- Options editor (for "choice" questions) ----
  function addOptionRow(optionsListEl, option) {
    const node = optionTpl.content.firstElementChild.cloneNode(true);
    node.dataset.oid = option?.id || uid('opt');
    node.querySelector('.o-label-en').value = option?.label_en || '';
    node.querySelector('.o-label-fr').value = option?.label_fr || '';
    node.querySelector('.remove-option-btn').addEventListener('click', () => {
      const card = node.closest('.question-card');
      node.remove();
      refreshShowIf(card.closest('.category-card'));
    });
    node.querySelector('.o-label-en').addEventListener('blur', () => refreshShowIf(node.closest('.category-card')));
    optionsListEl.appendChild(node);
  }

  // ---- Question editor ----
  function addQuestionRow(container, question) {
    const node = questionTpl.content.firstElementChild.cloneNode(true);
    node.dataset.qid = question?.id || uid('q');
    node.dataset.pendingShowIf = question?.showIf ? `${question.showIf.questionId}::${question.showIf.optionId}` : '';

    const typeSelect = node.querySelector('.q-type');
    typeSelect.value = question?.type === 'choice' ? 'choice' : 'text';
    node.querySelector('.q-label-en').value = question?.label_en || '';
    node.querySelector('.q-label-fr').value = question?.label_fr || '';
    node.querySelector('.q-style').value = question?.style === 'short' ? 'short' : 'paragraph';
    node.querySelector('.q-required input').checked = question?.required !== false;

    const optionsList = node.querySelector('.options-list');
    (question?.options || []).forEach((o) => addOptionRow(optionsList, o));

    function applyTypeVisibility() {
      const isChoice = typeSelect.value === 'choice';
      node.querySelector('.text-only').hidden = isChoice;
      node.querySelector('.choice-only').hidden = !isChoice;
    }
    applyTypeVisibility();

    typeSelect.addEventListener('change', () => {
      applyTypeVisibility();
      refreshShowIf(node.closest('.category-card'));
    });
    node.querySelector('.add-option-btn').addEventListener('click', () => addOptionRow(optionsList, null));
    node.querySelector('.remove-question-btn').addEventListener('click', () => {
      const card = node.closest('.category-card');
      node.remove();
      refreshShowIf(card);
    });
    node.querySelector('.q-label-en').addEventListener('blur', () => refreshShowIf(node.closest('.category-card')));

    container.appendChild(node);
  }

  // Recomputes every question's "only show if" dropdown so it lists every
  // choice-question + option that appears EARLIER in this category's list.
  function refreshShowIf(categoryCardEl) {
    if (!categoryCardEl) return;
    const rows = [...categoryCardEl.querySelectorAll('.question-card')];
    const candidatesSoFar = [];

    rows.forEach((row) => {
      const select = row.querySelector('.q-showif');
      const previousValue = select.dataset.currentValue || row.dataset.pendingShowIf || '';
      select.innerHTML = '';
      const alwaysOpt = document.createElement('option');
      alwaysOpt.value = '';
      alwaysOpt.textContent = 'Toujours';
      select.appendChild(alwaysOpt);
      for (const c of candidatesSoFar) {
        const opt = document.createElement('option');
        opt.value = c.value;
        opt.textContent = c.label;
        select.appendChild(opt);
      }
      const stillValid = candidatesSoFar.some((c) => c.value === previousValue);
      select.value = stillValid ? previousValue : '';
      select.dataset.currentValue = select.value;
      select.onchange = () => (select.dataset.currentValue = select.value);
      row.dataset.pendingShowIf = '';

      // If this row is itself a choice question, its options become candidates for LATER rows.
      const isChoice = row.querySelector('.q-type').value === 'choice';
      if (isChoice) {
        const qLabel = row.querySelector('.q-label-en').value || '(untitled question)';
        const qid = row.dataset.qid;
        row.querySelectorAll('.option-row').forEach((optRow) => {
          const oLabel = optRow.querySelector('.o-label-en').value || '(untitled option)';
          const oid = optRow.dataset.oid;
          candidatesSoFar.push({ value: `${qid}::${oid}`, label: `${qLabel} → ${oLabel}` });
        });
      }
    });
  }

  function collectQuestionsPayload(categoryCardEl) {
    return [...categoryCardEl.querySelectorAll('.question-card')].map((row) => {
      const type = row.querySelector('.q-type').value;
      const showIfValue = row.querySelector('.q-showif').value;
      const showIf = showIfValue ? { questionId: showIfValue.split('::')[0], optionId: showIfValue.split('::')[1] } : null;
      const base = {
        id: row.dataset.qid,
        type,
        label_en: row.querySelector('.q-label-en').value || 'Question',
        label_fr: row.querySelector('.q-label-fr').value || 'Question',
        showIf,
      };
      if (type === 'choice') {
        base.options = [...row.querySelectorAll('.option-row')].map((optRow) => ({
          id: optRow.dataset.oid,
          label_en: optRow.querySelector('.o-label-en').value || 'Option',
          label_fr: optRow.querySelector('.o-label-fr').value || 'Option',
        }));
      } else {
        base.style = row.querySelector('.q-style').value;
        base.required = row.querySelector('.q-required input').checked;
      }
      return base;
    });
  }

  // ---- Category cards ----
  function renderCategory(category) {
    const node = categoryTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = category.id;
    node.querySelector('.emoji-input').value = category.emoji || '';
    node.querySelector('.label-en-input').value = category.label_en || '';
    node.querySelector('.label-fr-input').value = category.label_fr || '';
    node.querySelector('.id-badge').textContent = category.id;
    node.querySelector('.ai-enabled-input').checked = !!category.aiEnabled;
    node.querySelector('.ai-knowledge-input').value = category.aiKnowledge || '';
    node.querySelector('.ai-redirect-input').checked = !!category.aiCanRedirect;

    buildRolesPicker(node.querySelector('.roles-picker'), category.roleIds || []);

    const qList = node.querySelector('.questions-list');
    (category.questions || []).forEach((q) => addQuestionRow(qList, q));

    node.querySelector('.add-question-btn').addEventListener('click', () => {
      addQuestionRow(qList, null);
      refreshShowIf(node);
    });
    node.querySelector('.save-category-btn').addEventListener('click', () => saveCategory(node));
    node.querySelector('.delete-category-btn').addEventListener('click', () => deleteCategory(node, category.id));

    categoryListEl.appendChild(node);
    refreshShowIf(node);
  }

  async function saveCategory(node) {
    const id = node.dataset.id;
    const roleIds = [...node.querySelectorAll('.role-chip input:checked')].map((i) => i.value);
    const payload = {
      emoji: node.querySelector('.emoji-input').value,
      label_en: node.querySelector('.label-en-input').value,
      label_fr: node.querySelector('.label-fr-input').value,
      roleIds,
      aiEnabled: node.querySelector('.ai-enabled-input').checked,
      aiKnowledge: node.querySelector('.ai-knowledge-input').value,
      aiCanRedirect: node.querySelector('.ai-redirect-input').checked,
      questions: collectQuestionsPayload(node),
    };
    await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    flashSaved(node.querySelector('.save-ok'));
  }

  async function deleteCategory(node, id) {
    if (!confirm('Supprimer cette catégorie ? Cette action est définitive.')) return;
    await api(`/api/categories/${id}`, { method: 'DELETE' });
    node.remove();
  }

  async function addCategory() {
    const category = await api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ label_en: 'New Category', label_fr: 'Nouvelle catégorie', emoji: '📁', roleIds: [], questions: [] }),
    });
    renderCategory(category);
  }

  // ---- Texts tab ----
  const TEXT_FIELDS = [
    { key: 'welcome', label: 'Message de bienvenue (avant le choix de langue)', single: true },
    { key: 'chooseCategory', label: 'Choix de la catégorie' },
    { key: 'ticketCreatedDM', label: "Ticket créé (message privé à l'utilisateur)" },
    { key: 'ticketClosedDM', label: 'Ticket fermé (message privé)' },
    { key: 'waitingForButtons', label: "Rappel d'utiliser les boutons" },
    { key: 'modalTitle', label: 'Titre du formulaire de questions' },
    { key: 'newTicketChannelIntro', label: "Titre de l'embed dans le salon staff" },
    { key: 'inactivityWarningDM', label: 'Avertissement avant fermeture automatique' },
    { key: 'ratingRequestDM', label: "Demande d'avis après fermeture" },
    { key: 'ratingThanksDM', label: 'Remerciement après avis' },
    { key: 'ratingCommentPrompt', label: 'Invitation à laisser un commentaire' },
    { key: 'redirectNotice', label: 'Message de redirection (utilise {from}, {to}, {staff})' },
    { key: 'redirectFollowupPromptDM', label: 'Invitation à répondre au nouveau questionnaire (après redirection)' },
    { key: 'redirectSimpleNoticeDM', label: 'Notice de redirection simple (sans nouvelles questions)' },
    { key: 'redirectFollowupDoneDM', label: 'Confirmation après le nouveau questionnaire' },
    { key: 'bannedDM', label: 'Message affiché à un utilisateur banni', single: true },
  ];

  function renderTexts() {
    const container = document.getElementById('textsList');
    container.innerHTML = '';
    const texts = config.settings.texts || {};
    for (const field of TEXT_FIELDS) {
      const group = document.createElement('div');
      group.className = 'text-field-group';
      const label = document.createElement('label');
      label.textContent = field.label;
      group.appendChild(label);

      if (field.single) {
        const ta = document.createElement('textarea');
        ta.dataset.textKey = field.key;
        ta.value = texts[field.key] || '';
        group.appendChild(ta);
      } else {
        const pair = document.createElement('div');
        pair.className = 'text-field-pair';
        const taEn = document.createElement('textarea');
        taEn.dataset.textKey = `${field.key}_en`;
        taEn.placeholder = 'English';
        taEn.value = texts[`${field.key}_en`] || '';
        const taFr = document.createElement('textarea');
        taFr.dataset.textKey = `${field.key}_fr`;
        taFr.placeholder = 'Français';
        taFr.value = texts[`${field.key}_fr`] || '';
        pair.appendChild(taEn);
        pair.appendChild(taFr);
        group.appendChild(pair);
      }
      container.appendChild(group);
    }
  }

  async function saveTexts() {
    const payload = {};
    document.querySelectorAll('#textsList [data-text-key]').forEach((el) => {
      payload[el.dataset.textKey] = el.value;
    });
    await api('/api/texts', { method: 'PUT', body: JSON.stringify(payload) });
    flashSaved(document.getElementById('textsSaved'));
  }

  // ---- Reviews / transcripts tab ----
  let reviewsLoaded = false;
  const TRANSCRIPT_ICONS = { user: '👤', staff: '🛠️', note: '📝', system: 'ℹ️', ai: '🤖' };

  function renderTranscriptBox(transcript, ratingComment) {
    const box = document.createElement('div');
    box.className = 'archive-transcript';
    if (!transcript.length) {
      box.innerHTML = '<p class="hint">Aucun message échangé.</p>';
    } else {
      for (const m of transcript) {
        const line = document.createElement('div');
        line.className = `transcript-entry ${m.from}`;
        const time = new Date(m.at).toLocaleTimeString('fr-FR');
        const attachmentsHtml = (m.attachments || [])
          .map((url, i) => `<a href="${url}" target="_blank" rel="noopener">📎 pièce jointe ${i + 1}</a>`)
          .join(' ');
        line.innerHTML = `<span class="who">${TRANSCRIPT_ICONS[m.from] || '•'} ${m.authorTag}</span><span class="hint">${time}</span><div>${(m.content || '').replace(/</g, '&lt;')}</div>${attachmentsHtml ? `<div class="transcript-attachments">${attachmentsHtml}</div>` : ''}`;
        box.appendChild(line);
      }
    }
    if (ratingComment) {
      const c = document.createElement('div');
      c.className = 'transcript-comment';
      c.textContent = `💬 Commentaire : ${ratingComment}`;
      box.appendChild(c);
    }
    return box;
  }

  function appendNoteForm(container, onSubmit) {
    const form = document.createElement('div');
    form.className = 'note-form';
    form.innerHTML = `
      <input class="note-author" placeholder="Ton nom (optionnel)" />
      <textarea class="note-content" placeholder="Ajouter une note visible uniquement par le staff..."></textarea>
      <button class="ghost note-submit-btn">📝 Ajouter la note</button>
    `;
    form.querySelector('.note-submit-btn').addEventListener('click', async () => {
      const author = form.querySelector('.note-author').value;
      const content = form.querySelector('.note-content').value;
      if (!content.trim()) return;
      await onSubmit(author, content);
      form.querySelector('.note-content').value = '';
    });
    container.appendChild(form);
  }

  async function loadReviews() {
    if (reviewsLoaded) return;
    reviewsLoaded = true;
    const [stats, entries] = await Promise.all([api('/api/stats'), api('/api/archive')]);

    const statsRow = document.getElementById('statsRow');
    statsRow.innerHTML = '';
    const blocks = [
      { value: stats.averageRating != null ? `${stats.averageRating.toFixed(1)} ⭐` : '—', label: 'Note moyenne' },
      { value: String(stats.ratedCount), label: 'Avis reçus' },
      { value: String(stats.totalClosed), label: 'Tickets fermés' },
    ];
    for (const b of blocks) {
      const el = document.createElement('div');
      el.className = 'stat-block';
      el.innerHTML = `<span class="stat-value">${b.value}</span><span class="stat-label">${b.label}</span>`;
      statsRow.appendChild(el);
    }

    const listEl = document.getElementById('archiveList');
    listEl.innerHTML = '';
    if (!entries.length) {
      listEl.innerHTML = '<p class="hint">Aucun ticket fermé pour le moment.</p>';
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'archive-row';
      const date = new Date(entry.closedAt).toLocaleString('fr-FR');
      const stars = entry.rating ? '⭐'.repeat(entry.rating.stars) : '—';
      row.innerHTML = `
        <div class="archive-row-head">
          <span>${entry.userTag} — ${entry.categoryLabelEn}</span>
          <span class="stars">${stars}</span>
        </div>
        <div class="archive-row-meta">
          Fermé le ${date} par ${entry.closedBy || '—'} (${entry.language.toUpperCase()})
          <button class="icon-btn delete-archive-btn" title="Supprimer cet avis / ce ticket">🗑️</button>
        </div>
      `;
      row.querySelector('.delete-archive-btn').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Supprimer définitivement ce ticket archivé et son avis ?')) return;
        await api(`/api/archive/${entry.id}`, { method: 'DELETE' });
        row.remove();
        const newStats = await api('/api/stats');
        const blocks2 = statsRow.querySelectorAll('.stat-value');
        if (blocks2[0]) blocks2[0].textContent = newStats.averageRating != null ? `${newStats.averageRating.toFixed(1)} ⭐` : '—';
        if (blocks2[1]) blocks2[1].textContent = String(newStats.ratedCount);
        if (blocks2[2]) blocks2[2].textContent = String(newStats.totalClosed);
      });
      row.addEventListener('click', async () => {
        const existing = row.querySelector('.archive-transcript');
        if (existing) {
          existing.remove();
          return;
        }
        const full = await api(`/api/archive/${entry.id}`);
        const box = renderTranscriptBox(full.transcript, full.rating && full.rating.comment);
        appendNoteForm(box, async (author, content) => {
          await api(`/api/archive/${entry.id}/note`, { method: 'POST', body: JSON.stringify({ author, content }) });
          const refreshed = await api(`/api/archive/${entry.id}`);
          box.replaceWith(renderTranscriptBox(refreshed.transcript, refreshed.rating && refreshed.rating.comment));
        });
        row.appendChild(box);
      });
      listEl.appendChild(row);
    }
  }

  // ---- Open tickets ----
  let ticketsLoaded = false;
  async function loadOpenTickets() {
    if (ticketsLoaded) return;
    ticketsLoaded = true;
    const tickets = await api('/api/tickets');
    const listEl = document.getElementById('openTicketsList');
    listEl.innerHTML = '';
    if (!tickets.length) {
      listEl.innerHTML = '<p class="hint">Aucun ticket ouvert actuellement.</p>';
      return;
    }
    for (const ticket of tickets) {
      const cat = config.categories.find((c) => c.id === ticket.categoryId);
      const row = document.createElement('div');
      row.className = 'archive-row';
      const opened = new Date(ticket.openedAt).toLocaleString('fr-FR');
      row.innerHTML = `
        <div class="archive-row-head">
          <span>&lt;@${ticket.userId}&gt; — ${cat ? cat.label_en : ticket.categoryId}</span>
          <span class="stars">${ticket.claimedByTag ? '🙋 ' + ticket.claimedByTag : ''}</span>
        </div>
        <div class="archive-row-meta">Ouvert le ${opened} (${(ticket.language || 'en').toUpperCase()}) — ${ticket.staffReplied ? 'staff a répondu' : 'en attente du staff'}</div>
      `;
      row.addEventListener('click', async () => {
        const existing = row.querySelector('.archive-transcript');
        if (existing) {
          existing.remove();
          return;
        }
        const full = await api(`/api/tickets/${ticket.userId}`);
        const box = renderTranscriptBox(full.transcript || []);
        appendNoteForm(box, async (author, content) => {
          await api(`/api/tickets/${ticket.userId}/note`, { method: 'POST', body: JSON.stringify({ author, content }) });
          const refreshed = await api(`/api/tickets/${ticket.userId}`);
          box.replaceWith(renderTranscriptBox(refreshed.transcript || []));
        });
        row.appendChild(box);
      });
      listEl.appendChild(row);
    }
  }

  // ---- Bans ----
  let bansLoaded = false;
  async function loadBans() {
    if (bansLoaded) return;
    bansLoaded = true;
    await refreshBansList();
    document.getElementById('addBanBtn').addEventListener('click', async () => {
      const userId = document.getElementById('banUserId').value.trim();
      const reason = document.getElementById('banReason').value.trim();
      if (!userId) return;
      try {
        await api('/api/bans', { method: 'POST', body: JSON.stringify({ userId, reason }) });
        document.getElementById('banUserId').value = '';
        document.getElementById('banReason').value = '';
        await refreshBansList();
      } catch (err) {
        alert("Impossible d'ajouter ce ban (ID invalide ou déjà banni).");
      }
    });
  }

  async function refreshBansList() {
    const list = await api('/api/bans');
    const listEl = document.getElementById('bansList');
    listEl.innerHTML = '';
    if (!list.length) {
      listEl.innerHTML = '<p class="hint">Aucun utilisateur banni.</p>';
      return;
    }
    for (const b of list) {
      const row = document.createElement('div');
      row.className = 'archive-row';
      const date = new Date(b.bannedAt).toLocaleString('fr-FR');
      row.innerHTML = `
        <div class="archive-row-head">
          <span>&lt;@${b.userId}&gt; (\`${b.userId}\`)</span>
          <button class="icon-btn remove-ban-btn" title="Débannir">🗑️</button>
        </div>
        <div class="archive-row-meta">${b.reason || 'Pas de raison indiquée'} — banni le ${date}</div>
      `;
      row.querySelector('.remove-ban-btn').addEventListener('click', async () => {
        await api(`/api/bans/${b.userId}`, { method: 'DELETE' });
        row.remove();
      });
      listEl.appendChild(row);
    }
  }

  // ---- Init ----
  async function init() {
    initTabs();
    [config, roles] = await Promise.all([api('/api/config'), api('/api/roles')]);

    document.getElementById('teamName').value = config.settings.teamName || '';
    const pingSelect = document.getElementById('pingRoleId');
    for (const role of roles) {
      const opt = document.createElement('option');
      opt.value = role.id;
      opt.textContent = role.name;
      pingSelect.appendChild(opt);
    }
    pingSelect.value = config.settings.pingRoleId || '';
    document.getElementById('anonymousReplies').checked = !!config.settings.anonymousReplies;

    const presence = config.settings.presence || {};
    document.getElementById('presenceType').value = presence.type || 'WATCHING';
    document.getElementById('presenceStatus').value = presence.status || 'online';
    document.getElementById('presenceText').value = presence.text || '';
    document.getElementById('presenceUrl').value = presence.url || '';
    const toggleStreamingUrl = () => {
      document.getElementById('presenceUrlField').hidden = document.getElementById('presenceType').value !== 'STREAMING';
    };
    toggleStreamingUrl();
    document.getElementById('presenceType').addEventListener('change', toggleStreamingUrl);
    document.getElementById('savePresence').addEventListener('click', async () => {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          presence: {
            type: document.getElementById('presenceType').value,
            status: document.getElementById('presenceStatus').value,
            text: document.getElementById('presenceText').value,
            url: document.getElementById('presenceUrl').value,
          },
        }),
      });
      flashSaved(document.getElementById('presenceSaved'));
    });

    api('/api/ai-status').then((status) => {
      const hint = document.getElementById('aiStatusHint');
      if (status.enabled) {
        hint.textContent = "✅ Clé Gemini détectée — L'IA Signature peut être activée par catégorie ci-dessous.";
      } else {
        hint.textContent = "⚠️ Aucune clé GEMINI_API_KEY configurée sur le serveur — active l'IA sur une catégorie ne fera rien tant que la variable d'environnement n'est pas ajoutée sur Render (voir le README).";
        hint.classList.add('warning');
      }
    });
    const aiSettings = config.settings.ai || {};
    document.getElementById('aiModel').value = aiSettings.model || 'gemini-3.6-flash';
    document.getElementById('aiMaxTurns').value = aiSettings.maxTurns || 6;
    document.getElementById('saveAiSettings').addEventListener('click', async () => {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ai: { model: document.getElementById('aiModel').value, maxTurns: document.getElementById('aiMaxTurns').value } }),
      });
      flashSaved(document.getElementById('aiSettingsSaved'));
    });

    api('/api/backup-status').then((status) => {
      if (status.upstashEnabled) {
        document.getElementById('backupHint').textContent = '✅ Upstash connecté — paramètres, catégories, textes, avis et bannissements sont sauvegardés en continu et restaurés automatiquement après un redéploiement.';
      } else if (status.githubSyncEnabled) {
        document.getElementById('backupHint').textContent = '✅ Synchronisation automatique vers GitHub activée — tes réglages sont sauvegardés en continu, même après un redéploiement. (Les avis ne sont pas couverts — connecte Upstash pour ça aussi, voir le README.)';
      }
    });
    document.getElementById('exportConfigBtn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = '/api/export';
      a.download = 'signature-modmail-config.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    document.getElementById('importConfigBtn').addEventListener('click', () => document.getElementById('importConfigFile').click());
    document.getElementById('importConfigFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!confirm('Cela va remplacer toute la configuration actuelle (catégories, textes, réglages). Continuer ?')) return;
        await api('/api/import', { method: 'POST', body: JSON.stringify(parsed) });
        alert('Configuration importée. La page va se recharger.');
        location.reload();
      } catch (err) {
        alert('Fichier invalide : ' + err.message);
      }
    });
    const autoClose = config.settings.autoClose || {};
    document.getElementById('autoCloseEnabled').checked = autoClose.enabled !== false;
    document.getElementById('inactivityHours').value = autoClose.inactivityHours ?? 24;
    document.getElementById('graceMinutes').value = autoClose.graceMinutes ?? 60;

    config.categories.forEach(renderCategory);
    renderTexts();

    document.getElementById('addCategoryBtn').addEventListener('click', addCategory);
    document.getElementById('saveTexts').addEventListener('click', saveTexts);
    document.getElementById('saveSettings').addEventListener('click', async () => {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          teamName: document.getElementById('teamName').value,
          pingRoleId: document.getElementById('pingRoleId').value,
          anonymousReplies: document.getElementById('anonymousReplies').checked,
          autoClose: {
            enabled: document.getElementById('autoCloseEnabled').checked,
            inactivityHours: document.getElementById('inactivityHours').value,
            graceMinutes: document.getElementById('graceMinutes').value,
          },
        }),
      });
      flashSaved(document.getElementById('settingsSaved'));
    });
  }

  init().catch((err) => {
    console.error(err);
    alert('Failed to load dashboard data. Check the server logs.');
  });
})();
