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
      let expanded = false;
      row.addEventListener('click', async () => {
        expanded = !expanded;
        const existing = row.querySelector('.archive-transcript');
        if (existing) {
          existing.remove();
          return;
        }
        const full = await api(`/api/archive/${entry.id}`);
        const box = document.createElement('div');
        box.className = 'archive-transcript';
        if (!full.transcript.length) {
          box.innerHTML = '<p class="hint">Aucun message échangé.</p>';
        } else {
          const icons = { user: '👤', staff: '🛠️', note: '📝', system: 'ℹ️' };
          for (const m of full.transcript) {
            const line = document.createElement('div');
            line.className = `transcript-entry ${m.from}`;
            const time = new Date(m.at).toLocaleTimeString('fr-FR');
            line.innerHTML = `<span class="who">${icons[m.from] || '•'} ${m.authorTag}</span><span class="hint">${time}</span><div>${(m.content || '').replace(/</g, '&lt;')}</div>`;
            box.appendChild(line);
          }
        }
        if (full.rating && full.rating.comment) {
          const c = document.createElement('div');
          c.className = 'transcript-comment';
          c.textContent = `💬 Commentaire : ${full.rating.comment}`;
          box.appendChild(c);
        }
        row.appendChild(box);
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
