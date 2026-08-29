(function () {
  let roles = [];
  let config = { settings: {}, categories: [] };

  const categoryListEl = document.getElementById('categoryList');
  const categoryTpl = document.getElementById('categoryTemplate');
  const questionTpl = document.getElementById('questionTemplate');

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  }

  function flashSaved(el) {
    el.hidden = false;
    setTimeout(() => (el.hidden = true), 1800);
  }

  function buildRolesPicker(container, selectedIds) {
    container.innerHTML = '';
    if (!roles.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No roles found — make sure GUILD_ID is set correctly and the bot is in your server.';
      container.appendChild(p);
      return;
    }
    for (const role of roles) {
      const label = document.createElement('label');
      label.className = 'role-chip' + (selectedIds.includes(role.id) ? ' active' : '');
      label.style.borderColor = selectedIds.includes(role.id) ? role.color : '';
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

  function addQuestionRow(container, question) {
    if (container.children.length >= 5) return;
    const node = questionTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.q-label-en').value = question?.label_en || '';
    node.querySelector('.q-label-fr').value = question?.label_fr || '';
    node.querySelector('.q-style').value = question?.style === 'short' ? 'short' : 'paragraph';
    node.querySelector('.q-required input').checked = question?.required !== false;
    node.querySelector('.remove-question-btn').addEventListener('click', () => node.remove());
    container.appendChild(node);
  }

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

    node.querySelector('.add-question-btn').addEventListener('click', () => addQuestionRow(qList, null));

    node.querySelector('.save-category-btn').addEventListener('click', () => saveCategory(node));
    node.querySelector('.delete-category-btn').addEventListener('click', () => deleteCategory(node, category.id));

    categoryListEl.appendChild(node);
  }

  function collectCategoryPayload(node) {
    const roleIds = [...node.querySelectorAll('.role-chip input:checked')].map((i) => i.value);
    const questions = [...node.querySelectorAll('.question-row')].map((row) => ({
      id: row.dataset.id || row.querySelector('.q-label-en').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) || `q-${Math.random().toString(36).slice(2, 7)}`,
      label_en: row.querySelector('.q-label-en').value || 'Question',
      label_fr: row.querySelector('.q-label-fr').value || 'Question',
      style: row.querySelector('.q-style').value,
      required: row.querySelector('.q-required input').checked,
    }));
    return {
      emoji: node.querySelector('.emoji-input').value,
      label_en: node.querySelector('.label-en-input').value,
      label_fr: node.querySelector('.label-fr-input').value,
      roleIds,
      questions,
    };
  }

  async function saveCategory(node) {
    const id = node.dataset.id;
    const payload = collectCategoryPayload(node);
    await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    flashSaved(node.querySelector('.save-ok'));
  }

  async function deleteCategory(node, id) {
    if (!confirm('Delete this category? This cannot be undone.')) return;
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

  async function init() {
    [config, roles] = await Promise.all([api('/api/config'), api('/api/roles')]);
    document.getElementById('teamName').value = config.settings.teamName || '';
    config.categories.forEach(renderCategory);

    document.getElementById('addCategoryBtn').addEventListener('click', addCategory);
    document.getElementById('saveSettings').addEventListener('click', async () => {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ teamName: document.getElementById('teamName').value }) });
      flashSaved(document.getElementById('settingsSaved'));
    });
  }

  init().catch((err) => {
    console.error(err);
    alert('Failed to load dashboard data. Check the server logs.');
  });
})();
