const fs = require('fs');
const path = require('path');

const BANS_PATH = path.join(__dirname, '..', 'data', 'bans.json');

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
  fs.writeFileSync(BANS_PATH, JSON.stringify(list, null, 2));
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

module.exports = { isBanned, addBan, removeBan, listBans: readAll };
