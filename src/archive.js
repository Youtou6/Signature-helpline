const fs = require('fs');
const path = require('path');

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'archive.json');
const MAX_ENTRIES = 500; // keep the archive file from growing unbounded on a JSON-file setup

function ensure() {
  if (!fs.existsSync(ARCHIVE_PATH)) {
    fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
    fs.writeFileSync(ARCHIVE_PATH, JSON.stringify([], null, 2));
  }
}

function readAll() {
  ensure();
  return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
}

function writeAll(list) {
  fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(list, null, 2));
}

function addEntry(entry) {
  const all = readAll();
  all.unshift(entry); // newest first
  if (all.length > MAX_ENTRIES) all.length = MAX_ENTRIES;
  writeAll(all);
  return entry;
}

function getById(id) {
  return readAll().find((e) => e.id === id) || null;
}

function setRating(id, patch) {
  const all = readAll();
  const idx = all.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  all[idx].rating = { ...(all[idx].rating || {}), ...patch };
  writeAll(all);
  return all[idx];
}

function deleteEntry(id) {
  const all = readAll();
  const next = all.filter((e) => e.id !== id);
  const removed = next.length !== all.length;
  if (removed) writeAll(next);
  return removed;
}

function appendTranscriptEntry(id, entry) {
  const all = readAll();
  const idx = all.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  all[idx].transcript = all[idx].transcript || [];
  all[idx].transcript.push({ at: Date.now(), ...entry });
  writeAll(all);
  return all[idx];
}

function listSummaries(limit = 200) {
  return readAll()
    .slice(0, limit)
    .map(({ id, userTag, categoryLabelEn, language, openedAt, closedAt, closedBy, closedReason, rating }) => ({
      id,
      userTag,
      categoryLabelEn,
      language,
      openedAt,
      closedAt,
      closedBy,
      closedReason,
      rating: rating || null,
    }));
}

function getStats() {
  const all = readAll();
  const rated = all.filter((e) => e.rating && typeof e.rating.stars === 'number');
  const average = rated.length ? rated.reduce((sum, e) => sum + e.rating.stars, 0) / rated.length : null;
  return {
    totalClosed: all.length,
    ratedCount: rated.length,
    averageRating: average,
  };
}

module.exports = { addEntry, getById, setRating, deleteEntry, appendTranscriptEntry, listSummaries, getStats, readAll };
