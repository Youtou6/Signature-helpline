const fs = require('fs');
const path = require('path');

const TICKETS_PATH = path.join(__dirname, '..', 'data', 'tickets.json');

function ensure() {
  if (!fs.existsSync(TICKETS_PATH)) {
    fs.mkdirSync(path.dirname(TICKETS_PATH), { recursive: true });
    fs.writeFileSync(TICKETS_PATH, JSON.stringify({}, null, 2));
  }
}

function readAll() {
  ensure();
  return JSON.parse(fs.readFileSync(TICKETS_PATH, 'utf8'));
}

function writeAll(data) {
  fs.writeFileSync(TICKETS_PATH, JSON.stringify(data, null, 2));
}

function getTicketByUser(userId) {
  const all = readAll();
  return all[userId] || null;
}

function getTicketByChannel(channelId) {
  const all = readAll();
  const entry = Object.entries(all).find(([, t]) => t.channelId === channelId);
  if (!entry) return null;
  const [userId, ticket] = entry;
  return { userId, ...ticket };
}

function createTicket(userId, ticket) {
  const all = readAll();
  all[userId] = {
    transcript: [],
    lastActivityAt: Date.now(),
    staffReplied: false,
    warningSentAt: null,
    archiveId: null,
    ticketMessageId: null,
    claimedBy: null,
    claimedByTag: null,
    answers: {},
    ...ticket,
  };
  writeAll(all);
}

function updateTicket(userId, patch) {
  const all = readAll();
  if (!all[userId]) return null;
  all[userId] = { ...all[userId], ...patch };
  writeAll(all);
  return all[userId];
}

function appendTranscript(userId, entry) {
  const all = readAll();
  if (!all[userId]) return;
  all[userId].transcript = all[userId].transcript || [];
  all[userId].transcript.push({ at: Date.now(), ...entry });
  writeAll(all);
}

function deleteTicketByUser(userId) {
  const all = readAll();
  delete all[userId];
  writeAll(all);
}

module.exports = {
  getTicketByUser,
  getTicketByChannel,
  createTicket,
  updateTicket,
  appendTranscript,
  deleteTicketByUser,
  readAll,
};
