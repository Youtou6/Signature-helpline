// Optional, zero-friction persistence: if UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN are set (Upstash's free tier - see README), the bot
// mirrors config.json / archive.json / bans.json to Redis on every save, and
// restores them from there on startup - before anything else reads the local
// files. This is what actually survives a Render redeploy, unlike the local
// disk. Entirely inert (no-op) if those env vars aren't set.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function isEnabled() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function command(args) {
  if (!isEnabled()) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      console.error('Upstash error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error('Upstash request failed:', err.message || err);
    return null;
  }
}

// Returns the stored string, or null if unset/unavailable - never throws.
async function pull(key) {
  return command(['GET', key]);
}

// Fire-and-forget safe: resolves true/false, never throws or blocks the caller.
async function push(key, value) {
  const result = await command(['SET', key, value]);
  return result === 'OK';
}

module.exports = { isEnabled, pull, push };
