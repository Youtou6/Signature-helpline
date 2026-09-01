const fs = require('fs');
const path = require('path');
const upstash = require('./upstash');

const BANS_PATH = path.join(__dirname, '..', 'data', 'bans.json');
const UPSTASH_KEY = 'signature:bans';

function ensure() {
  if (!fs.existsSync(BANS_PATH)) {
    fs.mkdirSync(path.dirname(BANS_PATH), { recursive: true });
    fs.writeFileSync(BANS_PATH, JSON.stringify([], null, 2));
  }
}

function readAll() {
  ensure();
  return JSON.parse(fs.readFileSync(BANS_PATH, 'utf8'));
}

function writeAll(list) {
  const content = JSON.stringify(list, null, 2);
  fs.writeFileSync(BANS_PATH, content);
  upstash.push(UPSTASH_KEY, content).catch(() => {});
}

function isBanned(userId) {
  return readAll().some((b) => b.userId === userId);
}

function addBan(userId, reason, bannedBy) {
  const all = readAll();
  if (all.some((b) => b.userId === userId)) return false;
  all.unshift({ userId, reason: reason || '', bannedBy: bannedBy || '', bannedAt: Date.now() });
  writeAll(all);
  return true;
}

function removeBan(userId) {
  const all = readAll();
  const next = all.filter((b) => b.userId !== userId);
  const removed = next.length !== all.length;
  if (removed) writeAll(next);
  return removed;
}

// Called once at startup, before anything else reads bans.json: pulls the
// last-saved ban list from Upstash (if configured) so it survives a redeploy.
async function hydrateBans() {
  if (!upstash.isEnabled()) return;
  const remote = await upstash.pull(UPSTASH_KEY);
  if (!remote) return;
  try {
    const parsed = JSON.parse(remote);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    fs.mkdirSync(path.dirname(BANS_PATH), { recursive: true });
    fs.writeFileSync(BANS_PATH, remote);
    console.log('Signature Modmail — ban list restored from Upstash.');
  } catch (err) {
    console.error('Upstash bans data was invalid, ignoring:', err.message);
  }
}

module.exports = { isBanned, addBan, removeBan, listBans: readAll, hydrateBans };
