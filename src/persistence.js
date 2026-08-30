// Optional: if GITHUB_TOKEN + GITHUB_REPO are set, every dashboard save is
// also committed back to the GitHub repo, so the next deploy on Render
// starts from the latest saved config instead of the defaults baked into
// the repo. Completely inert (no-op) if those env vars aren't set.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // "username/repo"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_PATH = 'data/config.json';
const DEBOUNCE_MS = 5000;

let pushTimer = null;

function isEnabled() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

async function pushNow(content) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'signature-modmail-bot',
    Accept: 'application/vnd.github+json',
  };
  try {
    let sha;
    const getRes = await fetch(`${apiUrl}?ref=${GITHUB_BRANCH}`, { headers });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'chore: sync dashboard config [skip render deploy if configured]',
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putRes.ok) {
      console.error('GitHub config sync failed:', putRes.status, await putRes.text());
    } else {
      console.log('GitHub config sync: data/config.json updated.');
    }
  } catch (err) {
    console.error('GitHub config sync error:', err);
  }
}

// Debounced so rapid successive dashboard edits (e.g. typing in a text field,
// saving several categories in a row) don't create a flood of commits.
function scheduleSync(getContent) {
  if (!isEnabled()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow(getContent()), DEBOUNCE_MS);
}

module.exports = { isEnabled, scheduleSync };
