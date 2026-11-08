import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  renameSync,
  rmSync
} from 'fs';
import { join } from 'path';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  extractMessageContent,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const DATA_DIR = join(ROOT_DIR, 'data');
const SESSIONS_DIR = join(ROOT_DIR, 'sessions');
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const ROOT_INDEX_FILE = join(ROOT_DIR, 'index.html');
const PUBLIC_INDEX_FILE = join(PUBLIC_DIR, 'index.html');
const DB_FILE = join(DATA_DIR, 'store.json');

for (const dir of [DATA_DIR, SESSIONS_DIR, PUBLIC_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Keep the existing root index.html layout and make it available to Express.
if (existsSync(ROOT_INDEX_FILE) && !existsSync(PUBLIC_INDEX_FILE)) {
  copyFileSync(ROOT_INDEX_FILE, PUBLIC_INDEX_FILE);
}

function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function formatJid(number) {
  const digits = normalizePhone(number);
  return digits ? `${digits}@s.whatsapp.net` : '';
}

const OWNER_NUMBER_RAW = normalizePhone(process.env.BOT_OWNER_NUMBER || '');
const OWNER_NUMBER = OWNER_NUMBER_RAW.length >= 10 && OWNER_NUMBER_RAW.length <= 15 ? OWNER_NUMBER_RAW : '';
if (!OWNER_NUMBER) {
  throw new Error('BOT_OWNER_NUMBER is required. Set the owner WhatsApp number (10-15 digits with country code) in Render Environment before starting Obsidian Lock.');
}

let db = {
  prefix: '.',
  whitelist: [],
  syncedNumbers: [],
  lockedGroups: {},
  antiKick: {}
};

if (existsSync(DB_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(DB_FILE, 'utf-8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      db = { ...db, ...saved };
    }
  } catch (err) {
    console.error('[Store] Could not read store.json; starting with default settings:', err.message);
  }
}

// Normalize older or malformed local state without changing any command names.
db.prefix = typeof db.prefix === 'string' && db.prefix.length ? db.prefix : '.';
db.whitelist = Array.isArray(db.whitelist)
  ? [...new Set(db.whitelist.map(normalizePhone).filter(n => n.length >= 10 && n.length <= 15))]
  : [];
db.syncedNumbers = Array.isArray(db.syncedNumbers)
  ? [...new Set(db.syncedNumbers.map(normalizePhone).filter(n => n.length >= 10 && n.length <= 15 && n !== OWNER_NUMBER))]
  : [];
db.lockedGroups = db.lockedGroups && typeof db.lockedGroups === 'object' && !Array.isArray(db.lockedGroups)
  ? db.lockedGroups
  : {};
db.antiKick = db.antiKick && typeof db.antiKick === 'object' && !Array.isArray(db.antiKick)
  ? db.antiKick
  : {};

function saveDB() {
  const tempFile = `${DB_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(db, null, 2));
  renameSync(tempFile, DB_FILE);
}

const activeSockets = new Map();
const pendingPairings = new Map();
const logger = pino({ level: 'silent' });

function styleResponse(tag, lines, footnote = 'DEFENSE MATRIX SECURE') {
  const content = lines.map(line => ` │  ${line}`).join('\n');
  return `┌─❖ [ OBSIDIAN // ${tag.toUpperCase()} ] ❖─┐\n│\n${content}\n│\n└─〔 ⬡ ${footnote} 〕─┘`;
}

const lidToPn = new Map();

function normalizeJid(jid = '') {
  return String(jid || '').replace(/:\d+(?=@)/, '');
}
function normalNumber(jid = '') {
  return normalizeJid(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
}
function chatJidOf(msg) {
  const remote = normalizeJid(msg?.key?.remoteJid || '');
  // WhatsApp may identify a private chat with a LID while exposing the phone JID as an alternate.
  if (remote.endsWith('@lid') && !remote.endsWith('@g.us')) {
    const phoneJid = normalizeJid(msg?.key?.remoteJidAlt || msg?.key?.senderPn || msg?.key?.participantPn || '');
    if (phoneJid.endsWith('@s.whatsapp.net')) return phoneJid;
  }
  return remote;
}
function rememberJidPair(first, second) {
  const a = normalizeJid(first);
  const b = normalizeJid(second);
  if (!a || !b || a === b) return;
  if (a.endsWith('@lid') && (b.endsWith('@s.whatsapp.net') || b.endsWith('@c.us'))) lidToPn.set(a, b);
  if (b.endsWith('@lid') && (a.endsWith('@s.whatsapp.net') || a.endsWith('@c.us'))) lidToPn.set(b, a);
  if (lidToPn.size > 10000) lidToPn.delete(lidToPn.keys().next().value);
}
function rememberJidAliases(key = {}) {
  const pairs = [
    [key.remoteJid, key.remoteJidAlt],
    [key.participant, key.participantAlt],
    [key.senderLid, key.senderPn],
    [key.participantLid, key.participantPn]
  ];
  for (const [a, b] of pairs) rememberJidPair(a, b);
}
function rememberParticipantAliases(participants = []) {
  for (const participant of participants || []) {
    const rawIds = [participant?.id, participant?.jid, participant?.lid, participant?.pn,
      participant?.phoneNumber, participant?.participantPn, participant?.participantLid]
      .filter(Boolean).map(value => {
        const id = normalizeJid(value);
        return /^\+?\d{7,16}$/.test(id) ? `${id.replace(/\D/g, '')}@s.whatsapp.net` : id;
      });
    for (const first of rawIds) {
      if (!first.endsWith('@lid')) continue;
      for (const second of rawIds) rememberJidPair(first, second);
    }
  }
}
function rememberAccountAliases(sock) {
  rememberJidPair(sock?.user?.id, sock?.user?.lid);
  rememberJidPair(sock?.user?.id, sock?.user?.phoneNumber);
}
function jidAliases(jid) {
  const value = normalizeJid(jid);
  const values = new Set(value ? [value] : []);
  const mapped = lidToPn.get(value);
  if (mapped) values.add(normalizeJid(mapped));
  if (value.endsWith('@s.whatsapp.net') || value.endsWith('@c.us')) {
    for (const [lid, pn] of lidToPn.entries()) {
      if (normalizeJid(pn) === value) values.add(lid);
    }
  }
  return values;
}
function senderJidOf(msg, sock = null) {
  // Messages written by the linked account's own phone are marked fromMe.
  if (msg?.key?.fromMe === true && sock?.user?.id) {
    rememberAccountAliases(sock);
    return normalizeJid(sock.user.id);
  }
  rememberJidAliases(msg?.key || {});
  const sender = normalizeJid(msg?.key?.participant || msg?.key?.remoteJid || '');
  if (sender.endsWith('@lid')) {
    const alt = normalizeJid(msg?.key?.senderPn || msg?.key?.participantPn || msg?.key?.remoteJidAlt || lidToPn.get(sender) || '');
    if (alt.endsWith('@s.whatsapp.net') || alt.endsWith('@c.us')) return alt;
  }
  return sender;
}

function canonicalJid(jid) {
  return normalizeJid(typeof jid === 'string' ? jid : '');
}

function jidNumber(jid) {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return '';
  return normalNumber(jid);
}

async function getGroupMetadata(sock, jid, forceRefresh = false) {
  if (!isGroup(jid)) throw new Error('This command works inside a WhatsApp group.');
  rememberAccountAliases(sock);
  const key = normalizeJid(jid);
  const cached = groupMetadataCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < 8000) {
    rememberParticipantAliases(cached.value?.participants || []);
    return cached.value;
  }
  const value = await sock.groupMetadata(key);
  rememberParticipantAliases(value?.participants || []);
  groupMetadataCache.set(key, { at: Date.now(), value });
  if (groupMetadataCache.size > 400) groupMetadataCache.delete(groupMetadataCache.keys().next().value);
  return value;
}
function invalidateGroupMetadata(jid) {
  if (jid) groupMetadataCache.delete(normalizeJid(jid));
  else groupMetadataCache.clear();
}
function sameJid(a, b) {
  const aa = jidAliases(a), bb = jidAliases(b);
  for (const value of aa) if (bb.has(value)) return true;
  // Compare digits only when both IDs are phone-number JIDs. LID values are
  // opaque identifiers and must not be mistaken for phone numbers.
  const phoneA = [...aa].find(value => value.endsWith('@s.whatsapp.net') || value.endsWith('@c.us'));
  const phoneB = [...bb].find(value => value.endsWith('@s.whatsapp.net') || value.endsWith('@c.us'));
  return Boolean(phoneA && phoneB && normalNumber(phoneA) && normalNumber(phoneA) === normalNumber(phoneB));
}
function participantIdentifiers(participant = {}) {
  return [participant.id, participant.jid, participant.lid, participant.pn,
    participant.phoneNumber, participant.participantPn, participant.participantLid]
    .filter(Boolean).map(value => {
      const id = normalizeJid(value);
      return /^\+?\d{7,16}$/.test(id) ? `${id.replace(/\D/g, '')}@s.whatsapp.net` : id;
    });
}
function participantIsAdmin(participant = {}) {
  return ['admin', 'superadmin'].includes(String(participant.admin || participant.role || '').toLowerCase());
}
function participantMatchesJid(participant, jid) {
  return participantIdentifiers(participant).some(id => sameJid(id, jid));
}
async function botIsAdmin(sock, jid, meta = null) {
  rememberAccountAliases(sock);
  const groupMeta = meta || await getGroupMetadata(sock, jid, true);
  const botIds = [sock?.user?.id, sock?.user?.lid, sock?.user?.phoneNumber].filter(Boolean);
  return (groupMeta.participants || []).some(p => participantIsAdmin(p) && botIds.some(bot => participantMatchesJid(p, bot)));
}

const groupMetadataCache = new Map();
function isGroup(jid) { return String(jid || '').endsWith('@g.us'); }

// Every identifier this account is known by. Group participants may list the
// bot under its LID, phone JID or phone number, so match against all of them.
function ownAccountIds(sock) {
  return [sock?.user?.id, sock?.user?.lid, sock?.user?.phoneNumber].filter(Boolean);
}

function isOwnAccountJid(sock, jid) {
  return ownAccountIds(sock).some(id => sameJid(id, jid));
}

// Message ids the bot sent, keyed by account number, so its own replies are
// not processed again when WhatsApp echoes them back.
const ownSentMessageIds = new Map();
function accountNumber(sock) {
  return normalNumber(sock?.user?.id || '');
}
function rememberSentMessage(sock, id) {
  if (!id) return;
  ownSentMessageIds.set(`${accountNumber(sock)}|${id}`, Date.now());
  if (ownSentMessageIds.size > 5000) ownSentMessageIds.delete(ownSentMessageIds.keys().next().value);
}

// Message ids already handled by any paired account in this process. One
// WhatsApp message can reach several sockets; it must get exactly one reply.
const seenMessageIds = new Map();
function markSeenMessage(id) {
  if (seenMessageIds.has(id)) return false;
  seenMessageIds.set(id, Date.now());
  if (seenMessageIds.size > 5000) seenMessageIds.delete(seenMessageIds.keys().next().value);
  return true;
}

// Every outgoing bot message goes through here so its echo can be recognised.
async function sendFrom(sock, jid, content, options = {}) {
  const sent = await sock.sendMessage(jid, content, options);
  if (sent?.key?.id) rememberSentMessage(sock, sent.key.id);
  return sent;
}

function extractJid(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return value.id || value.jid || value.participant || value.phoneNumber || '';
  }
  return '';
}

// Resolves a JID (phone or LID) to the owning phone number using the same
// alias map as the Madara bot.
async function resolvePhoneFromJid(sock, jid) {
  const raw = extractJid(jid);
  if (!raw) return '';
  if (sock) rememberAccountAliases(sock);
  for (const alias of jidAliases(raw)) {
    if (alias.endsWith('@s.whatsapp.net') || alias.endsWith('@c.us')) {
      const number = normalNumber(alias);
      if (number.length >= 10 && number.length <= 15) return number;
    }
  }
  return '';
}

async function isOwnerIdentity(sock, ...identities) {
  if (!OWNER_NUMBER) return false;
  for (const identity of identities) {
    if (await resolvePhoneFromJid(sock, identity) === OWNER_NUMBER) return true;
  }
  return false;
}

async function isProtectedIdentity(sock, jid) {
  if (await isOwnerIdentity(sock, jid)) return true;
  const number = await resolvePhoneFromJid(sock, jid);
  return Boolean(number && db.whitelist.includes(number));
}

async function hasCommandAccess(sock, ...identities) {
  if (await isOwnerIdentity(sock, ...identities)) return true;
  for (const identity of identities) {
    const number = await resolvePhoneFromJid(sock, identity);
    if (!number) continue;
    // The linked account, any other account paired on this service, and
    // owner-approved synced numbers can operate the bot.
    if (activeSockets.has(number) || isRegisteredOnDisk(number) || db.syncedNumbers.includes(number)) return true;
  }
  return false;
}

function getDisconnectStatusCode(error) {
  if (!error) return undefined;
  if (error instanceof Boom) return error.output?.statusCode;
  return error.output?.statusCode ?? error.statusCode ?? error.data?.statusCode;
}

async function updateGroupParticipants(sock, groupId, participants, action) {
  const result = await sock.groupParticipantsUpdate(groupId, participants, action);
  const results = Array.isArray(result) ? result : [result];
  const rejected = results.find(item => {
    if (!item || item.status == null) return false;
    const status = String(item.status).toLowerCase();
    return status !== '200' && status !== 'ok' && status !== 'success';
  });
  if (rejected) {
    throw new Error(`WhatsApp rejected ${action} (status ${rejected.status}).`);
  }
  return result;
}

function markPairing(number, changes) {
  const record = pendingPairings.get(number);
  if (record) Object.assign(record, changes);
}

// Retries quickly. WhatsApp often rejects a promote sent a moment after the add.
async function quickRetry(operation, attempts = 6, gapMs = 250) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(gapMs);
    }
  }
  throw lastError;
}

// Puts a protected admin back straight away: re-add if they were removed, then
// restore admin rights. No fixed waits.
async function restoreProtectedMember(sock, groupId, target, action, author, targetIsOwner) {
  const label = `${targetIsOwner ? 'Protected Owner' : 'Protected Admin'}: @${target.split('@')[0]}`;
  const actor = `@${String(author || '').split('@')[0] || 'unknown'}`;
  try {
    if (action === 'remove') {
      await quickRetry(() => updateGroupParticipants(sock, groupId, [target], 'add'), 3, 300);
    }
    await quickRetry(() => updateGroupParticipants(sock, groupId, [target], 'promote'));
    const restored = action === 'remove'
      ? styleResponse('ANTI-KICK TRIGGERED', [
          'Removal of protected identity detected.',
          label,
          'Status: Re-added and admin rights restored.'
        ], 'ASSET RECOVERY')
      : styleResponse('ANTI-DEMOTE TRIGGERED', [
          `Unauthorized demote by: ${actor}`,
          label,
          'Status: Admin rights reinstated.'
        ], 'CORPS SHIELDED');
    await sendFrom(sock, groupId, { text: restored, mentions: [target, author].filter(Boolean) });
  } catch (err) {
    console.error('[Sentinel] Could not restore protected member:', err?.message || err);
    await sendFrom(sock, groupId, {
      text: styleResponse('PROTECTION FAILED', [label, `Reason: ${err?.message || err}`])
    }).catch(() => {});
  }
}

// The same roster event reaches every paired account that is in the group.
// Act on it once, so protection never re-adds or re-promotes twice.
const recentParticipantEvents = new Map();
function firstTimeParticipantEvent(key) {
  const now = Date.now();
  for (const [k, t] of recentParticipantEvents) {
    if (now - t > 1500) recentParticipantEvents.delete(k);
  }
  if (recentParticipantEvents.has(key)) return false;
  recentParticipantEvents.set(key, now);
  return true;
}

async function handleParticipantEvent(sock, event = {}) {
  const { id: groupId, participants = [], action, author } = event;
  if (!isGroup(groupId)) return;
  rememberParticipantAliases(participants.map(p => (typeof p === 'string' ? { id: p } : p)));

  const locked = Boolean(db.lockedGroups[groupId]);
  const antiKick = Boolean(db.antiKick[groupId]);
  if (!locked && !antiKick) return;
  if (!['add', 'remove', 'demote', 'promote'].includes(action)) return;

  // Cached metadata keeps this off the network. If it cannot be read, still try.
  let metadata = null;
  try {
    metadata = await getGroupMetadata(sock, groupId, false);
  } catch (err) {
    console.warn('[Sentinel] Could not read group metadata:', err?.message || err);
  }
  if (metadata && !await botIsAdmin(sock, groupId, metadata)) return;

  const authorIsOwner = await isOwnerIdentity(sock, author);
  const targets = participants.map(extractJid).filter(Boolean);

  await Promise.all(targets.map(async target => {
    try {
      if (!firstTimeParticipantEvent(`${groupId}|${action}|${target}|${author || ''}`)) return;
      const targetIsOwner = await isOwnerIdentity(sock, target);
      const targetIsProtected = targetIsOwner || await isProtectedIdentity(sock, target);
      const authorIsTarget = Boolean(author) && sameJid(author, target);

      // The owner's protection is kept even when the owner joins as a regular member.
      if (action === 'add' && targetIsOwner) {
        await updateGroupParticipants(sock, groupId, [target], 'promote').catch(err =>
          console.error('[Sentinel] Could not grant the protected owner admin access:', err?.message || err));
        return;
      }

      // The owner's deliberate roster changes against others are honoured.
      if (authorIsOwner && !targetIsOwner) return;
      if (authorIsOwner && targetIsOwner && (action === 'demote' || action === 'remove')) return;

      // Anti-kick / anti-demote for protected admins. A protected admin who leaves
      // or demotes themselves is not forced back.
      if ((action === 'remove' || action === 'demote') && targetIsProtected) {
        if (authorIsTarget) return;
        await restoreProtectedMember(sock, groupId, target, action, author, targetIsOwner);
        return;
      }

      // Rogue promotion and intruder removal only apply during a lockdown.
      if (!locked) return;

      if (action === 'promote' && !targetIsProtected && !isOwnAccountJid(sock, target)) {
        try {
          await updateGroupParticipants(sock, groupId, [target], 'demote');
          await sendFrom(sock, groupId, {
            text: styleResponse('ROGUE PROMOTION SUPPRESSED', [
              `User @${target.split('@')[0]} elevated without clearance.`,
              'Action: Privileges stripped.'
            ], 'ROSTER LOCKED'),
            mentions: [target]
          });
        } catch (err) {
          console.error('[Sentinel] Could not reverse unapproved promotion:', err?.message || err);
        }
      }

      if (action === 'add' && !targetIsProtected) {
        try {
          await updateGroupParticipants(sock, groupId, [target], 'remove');
          await sendFrom(sock, groupId, {
            text: styleResponse('SECTOR QUARANTINED', [
              `New participant intercepted: @${target.split('@')[0]}`,
              'Action: Removed under active lockdown.'
            ], 'PERIMETER SEALED'),
            mentions: [target]
          });
        } catch (err) {
          console.error('[Sentinel] Could not remove new participant:', err?.message || err);
        }
      }
    } catch (err) {
      console.error('[Sentinel] Participant handling failed:', err?.message || err);
    }
  }));
}

async function attachSentinel(sock) {
  sock.ev.on('group-participants.update', (event) => {
    // Protection runs in the background so it never waits behind other events.
    handleParticipantEvent(sock, event).catch(err => console.error('[Sentinel Error]', err?.message || err));
  });

  sock.ev.on('messages.upsert', async ({ messages = [] }) => {
    for (const msg of messages) {
      try {
        if (!msg?.key?.id || !msg?.key?.remoteJid || !msg.message) continue;
        rememberJidAliases(msg.key);
        rememberAccountAliases(sock);

        // The bot's own reply, echoed back by WhatsApp.
        if (ownSentMessageIds.has(`${accountNumber(sock)}|${msg.key.id}`)) continue;

        // A message from another account paired with this bot is handled by
        // that account's own socket (its fromMe copy); skip this incoming copy.
        if (!msg.key.fromMe) {
          const senderNumberValue = normalNumber(senderJidOf(msg, sock));
          if (senderNumberValue && activeSockets.has(senderNumberValue)) continue;
        }

        // Exactly one reply per message, however many sockets received it.
        if (!markSeenMessage(msg.key.id)) continue;

        // Commands run in the background so a slow command never delays the next message.
        handleMessage(sock, msg).catch(err => console.error('[Command Error]', err?.message || err));
      } catch (err) {
        console.error('[Command Error]', err?.message || err);
      }
    }
  });
}

async function handleMessage(sock, msg) {
  if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return;

  const jid = chatJidOf(msg) || msg.key.remoteJid;
  if (!jid) return;
  const isGroup = jid.endsWith('@g.us');
  // Unwrap disappearing-message, view-once and document-with-caption wrappers.
  const content = extractMessageContent(msg.message) || msg.message;
  const body =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    '';

  const pfx = db.prefix;
  if (typeof body !== 'string' || !body.startsWith(pfx)) return;

  const args = body.slice(pfx.length).trim().split(/ +/).filter(Boolean);
  const cmd = (args.shift() || '').toLowerCase();
  const query = args.join(' ').trim();
  if (!cmd) return;

  rememberJidAliases(msg.key || {});
  rememberAccountAliases(sock);
  const senderJid = senderJidOf(msg, sock);
  // Messages from the linked account carry only that account's identity.
  // Never use the chat partner's JID for them, or the linked account would be
  // mistaken for whoever it is talking to.
  const senderIdentities = msg.key.fromMe
    ? [sock.user?.id]
    : [senderJid, msg.key.participant, msg.key.participantAlt, isGroup ? undefined : msg.key.remoteJidAlt];
  const senderIsOwner = await isOwnerIdentity(sock, ...senderIdentities);
  const senderIsLinked = msg.key.fromMe === true;


  // The protected owner manages synchronization. Paired bot accounts and
  // owner-approved synced numbers can use the full existing command set.
  if (cmd === 'syncn') {
    if (!senderIsOwner) {
      return sendFrom(sock, jid, {
        text: styleResponse('ACCESS DENIED', ['Only the configured bot owner can modify synchronized command access.'])
      }, { quoted: msg });
    }

    const syncAction = (args[0] || '').toLowerCase();
    if (syncAction === 'clear') {
      const removedCount = db.syncedNumbers.length;
      db.syncedNumbers = [];
      saveDB();
      return sendFrom(sock, jid, {
        text: styleResponse('SYNC NETWORK CLEARED', [
          `Synchronized numbers removed: ${removedCount}`,
          'Only the configured owner and paired bot accounts retain command access.'
        ], 'OWNER CONTROL')
      }, { quoted: msg });
    }

    if (syncAction === 'remove') {
      const removalTokens = query.slice(args[0].length).trim().split(/[;,\s]+/).filter(Boolean);
      const removalNumbers = removalTokens.map(normalizePhone);
      const invalidRemovals = removalNumbers.filter(number => number.length < 10 || number.length > 15);
      if (!removalNumbers.length || invalidRemovals.length) {
        return sendFrom(sock, jid, {
          text: styleResponse('INVALID REMOVAL LIST', [
            `Usage: ${pfx}syncN remove 2348011111111,2348022222222`
          ])
        }, { quoted: msg });
      }
      const beforeCount = db.syncedNumbers.length;
      const removalSet = new Set(removalNumbers);
      db.syncedNumbers = db.syncedNumbers.filter(number => !removalSet.has(number));
      saveDB();
      return sendFrom(sock, jid, {
        text: styleResponse('SYNC ACCESS REVOKED', [
          `Numbers removed: ${beforeCount - db.syncedNumbers.length}`,
          `Remaining synchronized numbers: ${db.syncedNumbers.length}`
        ], 'OWNER CONTROL')
      }, { quoted: msg });
    }

    if (!query) {
      const lines = db.syncedNumbers.length
        ? db.syncedNumbers.map((number, index) => `[${index + 1}] +${number}`)
        : ['No synchronized numbers have been added yet.'];
      return sendFrom(sock, jid, {
        text: styleResponse('SYNCED OPERATORS', [
          `Total synchronized numbers: ${db.syncedNumbers.length}`,
          ...lines,
          `Usage: ${pfx}syncN 2348011111111,2348022222222`
        ], 'OWNER CONTROL')
      }, { quoted: msg });
    }

    const rawNumbers = query.split(/[;,\s]+/).filter(Boolean);
    const numbers = rawNumbers.map(normalizePhone);
    const invalidNumbers = numbers.filter(number => number.length < 10 || number.length > 15);
    if (!numbers.length || invalidNumbers.length) {
      return sendFrom(sock, jid, {
        text: styleResponse('INVALID NUMBER LIST', [
          'Use full international phone numbers with country code.',
          `Example: ${pfx}syncN 2348011111111,2348022222222`,
          ...(invalidNumbers.length ? [`Invalid entries: ${invalidNumbers.join(', ')}`] : [])
        ])
      }, { quoted: msg });
    }

    const additions = [...new Set(numbers)].filter(number =>
      number !== OWNER_NUMBER && !db.syncedNumbers.includes(number)
    );
    db.syncedNumbers = [...new Set([...db.syncedNumbers, ...additions])];
    saveDB();

    return sendFrom(sock, jid, {
      text: styleResponse('SYNC NETWORK UPDATED', [
        `New numbers added: ${additions.length}`,
        `Total synchronized operators: ${db.syncedNumbers.length}`,
        ...db.syncedNumbers.map((number, index) => `[${index + 1}] +${number}`),
        'Access: Full existing bot command set across paired sessions.'
      ], 'SYNC COMPLETE')
    }, { quoted: msg });
  }

  const senderHasAccess = await hasCommandAccess(sock, ...senderIdentities);
  if (!senderHasAccess && process.env.DEBUG_IDENTITY) {
    const described = senderIdentities.filter(Boolean).map(j => {
      const n = jidNumber(canonicalJid(String(j)));
      return `${String(j).split('@')[1] || '?'}:${n ? '…' + n.slice(-4) : 'unresolved'}`;
    });
    console.warn(`[Identity] denied command "${cmd}" from fromMe=${Boolean(msg.key.fromMe)} identities=[${described.join(', ')}] owner=…${OWNER_NUMBER.slice(-4)}`);
  }
  const senderResolvedNumber = await resolvePhoneFromJid(sock, senderJid);
  const senderIsSynced = Boolean(senderResolvedNumber && db.syncedNumbers.includes(senderResolvedNumber));
  if (!senderHasAccess) {
    return sendFrom(sock, jid, {
      text: styleResponse('ACCESS DENIED', [
        'This number is not authorized to operate Obsidian Lock.',
        'Ask the configured bot owner to add it with .syncN.'
      ])
    }, { quoted: msg });
  }

  if (cmd === 'antikick') {
    if (!isGroup) {
      return sendFrom(sock, jid, {
        text: styleResponse('ERROR', ['Use .antikick inside the group you want to protect.'])
      }, { quoted: msg });
    }
    const mode = (args[0] || '').toLowerCase();
    if (!mode) {
      return sendFrom(sock, jid, {
        text: styleResponse('ANTI-KICK STATUS', [
          `Protected admins in this group: ${db.antiKick[jid] ? 'ARMED' : 'OFF'}`,
          `Usage: ${pfx}antikick on/off`
        ])
      }, { quoted: msg });
    }
    if (mode !== 'on' && mode !== 'off') {
      return sendFrom(sock, jid, {
        text: styleResponse('INVALID INPUT', [`Usage: ${pfx}antikick on/off`])
      }, { quoted: msg });
    }
    if (mode === 'on') db.antiKick[jid] = true;
    else delete db.antiKick[jid];
    saveDB();
    return sendFrom(sock, jid, {
      text: mode === 'on'
        ? styleResponse('ANTI-KICK ARMED', [
            'Protected admins (owner and .LK-promote list) are re-added and re-promoted at once if removed or demoted.'
          ], 'SHIELD ONLINE')
        : styleResponse('ANTI-KICK DISARMED', ['Protected admins are no longer restored automatically.'], 'SHIELD OFF')
    }, { quoted: msg });
  }

  if (cmd === 'menu') {
    const lines = [
      `System: OBSIDIAN LOCK // EMERGENCY SENTINEL`,
      `Prefix: [ ${db.prefix} ]`,
      `Armed Sectors: ${Object.keys(db.lockedGroups).length}`,
      `Protected Officers: ${db.whitelist.length}`,
      `Protected Owner: ${OWNER_NUMBER ? 'RECOGNIZED' : 'NOT CONFIGURED'}`,
      `Command Operator: ${senderIsOwner ? 'BOT OWNER' : (senderIsLinked ? 'LINKED ACCOUNT' : (senderIsSynced ? 'SYNCED OPERATOR' : 'PAIRED USER'))}`,
      `Synced Operators: ${db.syncedNumbers.length}`,
      `─────────────────────────────`,
      `◈ COMMAND PROTOCOLS ◈`,
      `${pfx}menu`,
      `  ↳ Display this command terminal`,
      `${pfx}setprefix <symbol>`,
      `  ↳ Reassign the global execution trigger`,
      `${pfx}groupid`,
      `  ↳ Reveal current sector ID (Group JID)`,
      `${pfx}LK-promote <num1,num2,...>`,
      `  ↳ Save and update protected officer numbers`,
      `${pfx}syncN <num1,num2,...>`,
      `  ↳ Owner: grant full command access to numbers`,
      `${pfx}syncN remove <num1,num2,...> / clear`,
      `  ↳ Owner: revoke synchronized command access`,
      `${pfx}group-LK <optional: group_id>`,
      `  ↳ Initiate lockdown: seals chat, removes`,
      `    rogue admins, installs whitelisted admins,`,
      `    arms millisecond anti-demote & anti-kick`,
      `${pfx}group-LK off <optional: group_id>`,
      `  ↳ Deactivate lockdown and restore normal open mode`,
      `${pfx}antikick on/off`,
      `  ↳ Protected admins are restored at once if removed or demoted`
    ];
    return sendFrom(sock, jid, { text: styleResponse('SENTINEL ARSENAL', lines, 'READY') }, { quoted: msg });
  }

  if (cmd === 'setprefix') {
    if (!args[0]) {
      return sendFrom(sock, jid, {
        text: styleResponse('INVALID INPUT', [`Specify target prefix. Example: ${pfx}setprefix !`])
      }, { quoted: msg });
    }
    db.prefix = args[0];
    saveDB();
    return sendFrom(sock, jid, {
      text: styleResponse('TRIGGER REASSIGNED', [`System prefix updated to: [ ${db.prefix} ]`])
    }, { quoted: msg });
  }

  if (cmd === 'groupid') {
    if (!isGroup) {
      return sendFrom(sock, jid, {
        text: styleResponse('ERROR', ['This protocol must be issued from inside a group.'])
      }, { quoted: msg });
    }
    return sendFrom(sock, jid, {
      text: styleResponse('SECTOR RECON', [
        `Target Group: ${jid}`,
        'Status: Authenticated'
      ])
    }, { quoted: msg });
  }

  if (cmd === 'lk-promote') {
    if (!query) {
      return sendFrom(sock, jid, {
        text: styleResponse('MISSING ROSTER', [
          'Provide phone numbers with country code.',
          `Example: ${pfx}LK-promote 234801111111,234802222222`
        ])
      }, { quoted: msg });
    }

    const numbers = query
      .split(',')
      .map(n => normalizePhone(n))
      .filter(n => n.length >= 10 && n.length <= 15);

    if (!numbers.length) {
      return sendFrom(sock, jid, {
        text: styleResponse('PARSE ERROR', ['No valid numbers detected. Ensure digits only with country code.'])
      }, { quoted: msg });
    }

    db.whitelist = [...new Set([...db.whitelist, ...numbers])];
    saveDB();
    return sendFrom(sock, jid, {
      text: styleResponse('OFFICER CORPS UPDATED', [
        `Saved Protected Officers: ${db.whitelist.length}`,
        ...db.whitelist.map((num, idx) => `[${idx + 1}] +${num}`)
      ], 'ROSTER SECURED')
    }, { quoted: msg });
  }

  if (cmd === 'group-lk') {
    const mode = (args[0] || '').toLowerCase();
    let targetGroup = '';

    if (mode === 'off') {
      targetGroup = args[1] || (isGroup ? jid : '');
      if (!targetGroup.endsWith('@g.us')) {
        return sendFrom(sock, jid, {
          text: styleResponse('ERROR', ['Specify a valid group ID or run inside a group.'])
        }, { quoted: msg });
      }

      try {
        await sock.groupSettingUpdate(targetGroup, 'not_announcement');
      } catch (err) {
        console.error('[Lockdown] Could not reopen group:', err.message);
        return sendFrom(sock, jid, {
          text: styleResponse('OPERATION FAILED', [`Could not reopen the group: ${err.message}`])
        }, { quoted: msg });
      }

      delete db.lockedGroups[targetGroup];
      saveDB();
      return sendFrom(sock, jid, {
        text: styleResponse('LOCKDOWN DISARMED', [
          `Group: ${targetGroup}`,
          'Perimeter opened to all members.',
          'Intruder quarantine disengaged.'
        ], 'SECTOR OPEN')
      }, { quoted: msg });
    }

    targetGroup = (args[0]?.endsWith('@g.us') ? args[0] : (isGroup ? jid : ''));
    if (!targetGroup || !targetGroup.endsWith('@g.us')) {
      return sendFrom(sock, jid, {
        text: styleResponse('USAGE ERROR', [
          'Execute inside the group or specify target ID:',
          `  ${pfx}group-LK`,
          `  ${pfx}group-LK 123456789-987654@g.us`,
          `  ${pfx}group-LK off`
        ])
      }, { quoted: msg });
    }

    let meta;
    try {
      meta = await getGroupMetadata(sock, targetGroup, true);
    } catch (err) {
      return sendFrom(sock, jid, {
        text: styleResponse('ACCESS FAILED', ['Bot must be a member of the group to query permissions.'])
      }, { quoted: msg });
    }

    if (!await botIsAdmin(sock, targetGroup, meta)) {
      return sendFrom(sock, jid, {
        text: styleResponse('PERMISSION REVOKED', [
          `Obsidian Lock is NOT an admin in ${meta.subject}.`,
          'Promote bot to Admin before invoking lockdown.'
        ])
      }, { quoted: msg });
    }

    // Resolve the owner's actual group JID before changing group permissions.
    let ownerParticipant = null;
    if (OWNER_NUMBER) {
      for (const participant of meta.participants) {
        if (await isOwnerIdentity(sock, participant.id)) {
          ownerParticipant = participant;
          break;
        }
      }
    }
    const ownerPresent = Boolean(ownerParticipant);
    if (ownerParticipant && ownerParticipant.admin !== 'admin' && ownerParticipant.admin !== 'superadmin') {
      try {
        await updateGroupParticipants(sock, targetGroup, [ownerParticipant.id], 'promote');
      } catch (err) {
        console.error('[Lockdown] Could not protect owner access:', err.message);
        return sendFrom(sock, jid, {
          text: styleResponse('OWNER PROTECTION FAILED', [
            'Lockdown was not activated because the configured owner is in this group but could not be promoted.',
            `Reason: ${err.message}`
          ])
        }, { quoted: msg });
      }
    }

    await sendFrom(sock, jid, {
      text: styleResponse('EXECUTING EMERGENCY LOCKDOWN', [
        `Target: ${meta.subject}`,
        '[1] Preserving configured owner access...',
        '[2] Restricting chat to administrators...',
        '[3] Reviewing administrator ranks...',
        '[4] Arming sentinel defense sensors...'
      ], 'LOCKDOWN COMMENCING')
    });

    try {
      await sock.groupSettingUpdate(targetGroup, 'announcement');
    } catch (err) {
      console.error('[Lockdown] Could not restrict group chat:', err.message);
      return sendFrom(sock, jid, {
        text: styleResponse('OPERATION FAILED', [`Could not restrict group chat: ${err.message}`])
      }, { quoted: msg });
    }

    const operationErrors = [];

    const participantIsProtected = async (participant) => isProtectedIdentity(sock, participant.id);

    for (const participant of meta.participants) {
      const participantJid = canonicalJid(participant.id);
      const protectedIdentity = await participantIsProtected(participant);
      const isBot = isOwnAccountJid(sock, participant.id);
      const isAdmin = participant.admin === 'admin' || participant.admin === 'superadmin';
      if (!isAdmin || isBot || protectedIdentity) continue;

      try {
        await updateGroupParticipants(sock, targetGroup, [participant.id], 'demote');
      } catch (err) {
        operationErrors.push(`Could not change admin status for ${participantJid}: ${err.message}`);
        console.error('[Lockdown] Demotion failed:', err.message);
      }
    }

    // Existing whitelist behavior is retained. The owner is only promoted if
    // already a member; the bot never silently adds the owner's number.
    // Owner is protected separately and never auto-added through the roster.
    const officersToPromote = db.whitelist.filter(number => number !== OWNER_NUMBER);

    for (const officerNum of officersToPromote) {
      let existingParticipant = null;
      for (const participant of meta.participants) {
        const participantNumber = await resolvePhoneFromJid(sock, participant.id);
        if (participantNumber === officerNum) {
          existingParticipant = participant;
          break;
        }
      }
      const officerJid = existingParticipant?.id || formatJid(officerNum);
      if (!existingParticipant) {
        try {
          await updateGroupParticipants(sock, targetGroup, [officerJid], 'add');
        } catch (err) {
          operationErrors.push(`Could not add +${officerNum}: ${err.message}`);
          console.error('[Lockdown] Officer add failed:', err.message);
          continue;
        }
      }
      try {
        await updateGroupParticipants(sock, targetGroup, [officerJid], 'promote');
      } catch (err) {
        operationErrors.push(`Could not promote +${officerNum}: ${err.message}`);
        console.error('[Lockdown] Officer promotion failed:', err.message);
      }
    }

    db.lockedGroups[targetGroup] = true;
    saveDB();

    const summaryLines = [
      'Emergency Lockdown Status: ACTIVE',
      'Chat Mode: Admin Only',
      `Active Officers: ${db.whitelist.filter(number => number !== OWNER_NUMBER).length}${ownerPresent ? ' + protected owner' : ''}`,
      'Sentinel Safeguards:',
      ' • Anti-Demote: ACTIVE (protected identities only)',
      ' • Anti-Kick: ACTIVE (protected identities only)',
      ' • Anti-Rogue Promote: ACTIVE',
      ' • Intruder Quarantine: ACTIVE',
      `Owner Recognition: ${OWNER_NUMBER ? 'ACTIVE' : 'NOT CONFIGURED'}`
    ];
    if (operationErrors.length) {
      summaryLines.push(`Operations needing attention: ${operationErrors.length}`);
      summaryLines.push(...operationErrors.slice(0, 4));
    }

    return sendFrom(sock, targetGroup, {
      text: styleResponse('OBSIDIAN PERIMETER SECURED', summaryLines, 'SHIELD OVERWATCH ACTIVE')
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session and pairing lifecycle (modelled on the Madara pairing flow).
//
// Key rules:
//  * A pairing code is only requested AFTER WhatsApp reports the pre-auth
//    socket is ready (the `qr` event). Requesting it earlier fails with
//    "Connection Closed".
//  * A code belongs to the socket that issued it. When WhatsApp drops that
//    socket (428/401/408/...) before linking, the code is dead, so the runner
//    opens a fresh clean socket and issues a NEW code instead of reconnecting
//    with the same half-registered credentials (that reuse caused the 401 loop).
//  * Only registered (fully paired) credentials are ever restored at boot or
//    grant command access. Unfinished pairings never do.
// ─────────────────────────────────────────────────────────────────────────────
const WA_BROWSER = Browsers.ubuntu('Chrome');
const PAIRING_ATTEMPTS_MAX = 8;
const PAIRING_TTL_MS = Number(process.env.PAIRING_TTL_MS || 10 * 60 * 1000);
const launchingNumbers = new Set();
let waVersionPromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sessionPathFor(number) {
  return join(SESSIONS_DIR, number);
}

function isRegisteredOnDisk(number) {
  try {
    const creds = JSON.parse(readFileSync(join(sessionPathFor(number), 'creds.json'), 'utf-8'));
    return creds?.registered === true;
  } catch {
    return false;
  }
}

function getWaVersion() {
  waVersionPromise ||= fetchLatestBaileysVersion()
    .then(result => result.version)
    .catch(err => {
      console.warn('[WA] Could not fetch latest WhatsApp version; using Baileys default:', err.message);
      return undefined;
    });
  return waVersionPromise;
}

// A pairing record is "alive" while it is still trying to get a device linked.
function isAlivePairing(record) {
  return Boolean(record)
    && !record.cancelled
    && !record.linked
    && Date.now() < record.deadline
    && !['failed', 'open'].includes(record.status);
}

function failPairing(record, reason) {
  if (!record || record.status === 'open') return;
  record.cancelled = true;
  record.status = 'failed';
  record.error = reason;
  disposeSocket(record.sock);
  record.sock = null;
  console.warn(`[Pairing ${record.number}] failed: ${reason}`);
}

function disposeSocket(state) {
  if (!state || state.disposed) return;
  state.disposed = true;
  state.resolveReady?.(false);
  state.resolveClosed?.();
  try { state.sock?.end?.(new Error('Socket disposed')); } catch {}
  if (activeSockets.get(state.number) === state.sock) activeSockets.delete(state.number);
}

// Opens one Baileys socket for a number. When `record` is given, the socket is
// the pairing socket (or the post-link reconnect of that same pairing).
async function launchSocket(number, record = null) {
  const sessionPath = sessionPathFor(number);
  mkdirSync(sessionPath, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(sessionPath);
  const version = await getWaVersion();

  const current = { number, sock: null, disposed: false, closed: false, sentinelAttached: false };
  current.readyPromise = new Promise(resolve => { current.resolveReady = resolve; });
  current.closedPromise = new Promise(resolve => { current.resolveClosed = resolve; });

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: WA_BROWSER,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
    emitOwnEvents: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000
  });
  current.sock = sock;
  if (record) record.sock = current;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (current.disposed) return;
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    // Pre-auth socket is ready for requestPairingCode.
    if (qr && !authState.creds.registered) {
      current.resolveReady?.(true);
    }

    if (isNewLogin && record && !record.linked) {
      // The phone accepted the code. WhatsApp will close this socket once
      // (restartRequired) and the reconnect below completes the link.
      record.linked = true;
      record.status = 'connecting';
      record.error = null;
      record.message = 'Code accepted. Finishing the link with WhatsApp…';
    }

    if (connection === 'open') {
      console.log(`[Session Online] +${number}`);
      activeSockets.set(number, sock);
      if (record) {
        record.linked = true;
        record.status = 'open';
        record.error = null;
      }
      if (!current.sentinelAttached) {
        current.sentinelAttached = true;
        await attachSentinel(sock);
      }
      return;
    }

    if (connection !== 'close') return;

    current.closed = true;
    current.resolveReady?.(false);
    current.resolveClosed?.();
    if (activeSockets.get(number) === sock) activeSockets.delete(number);

    const statusCode = getDisconnectStatusCode(lastDisconnect?.error);
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    console.warn(`[Session Closed] +${number}; status=${statusCode ?? 'unknown'}; loggedOut=${loggedOut}`);

    // Pre-link close: the pairing runner obtains a fresh code. Do not reuse
    // these credentials to reconnect.
    if (record && !record.linked) return;

    if (loggedOut) {
      rmSync(sessionPath, { recursive: true, force: true });
      if (record && record.status !== 'open') failPairing(record, 'WhatsApp logged this device out. Pair again.');
      return;
    }

    // Registered (or just-linked) session: stay connected.
    const delay = statusCode === DisconnectReason.restartRequired ? 300 : 3000;
    setTimeout(() => {
      launchSocket(number, record).catch(err =>
        console.error(`[Reconnect ${number}]`, err?.stack || err?.message || err)
      );
    }, delay);
  });

  return current;
}

// Restores a registered session. Unpaired folders are never started here.
async function startSession(phone) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) {
    throw new Error('Invalid WhatsApp phone number.');
  }
  if (activeSockets.has(cleanPhone)) return activeSockets.get(cleanPhone);
  if (launchingNumbers.has(cleanPhone)) return null;
  if (!isRegisteredOnDisk(cleanPhone)) throw new Error('No paired session exists for this number.');

  launchingNumbers.add(cleanPhone);
  try {
    return await launchSocket(cleanPhone, null);
  } finally {
    launchingNumbers.delete(cleanPhone);
  }
}

// Obtains one valid pairing code on a clean socket.
async function issueCode(record) {
  const number = record.number;
  disposeSocket(record.sock);
  record.sock = null;
  // Clean identity for every attempt: stale pre-auth keys are what WhatsApp rejects.
  rmSync(sessionPathFor(number), { recursive: true, force: true });

  const state = await launchSocket(number, record);
  const ready = await Promise.race([state.readyPromise, sleep(20000).then(() => false)]);
  if (!ready || state.closed || !isAlivePairing(record) || record.sock !== state) {
    throw new Error('WhatsApp did not open a pairing channel.');
  }

  const code = String(await state.sock.requestPairingCode(number) || '').trim().toUpperCase();
  if (!code) throw new Error('WhatsApp returned an empty pairing code.');
  if (!isAlivePairing(record) || record.sock !== state) throw new Error('Pairing was replaced.');

  record.code = code;
  record.codeVersion = (record.codeVersion || 0) + 1;
  record.status = 'code_ready';
  record.error = null;
  record.message = 'Enter this code in WhatsApp: Linked Devices > Link with phone number.';
  console.log(`[Pairing ${number}] code issued (version ${record.codeVersion}).`);
}

// Drives one pairing from first code until linked, failed, or timed out.
// WhatsApp closing the pre-auth socket is normal: refresh the code and keep going.
async function runPairing(record) {
  let lastError = 'Could not get a pairing code.';

  for (let attempt = 1; attempt <= PAIRING_ATTEMPTS_MAX; attempt++) {
    if (!isAlivePairing(record)) return;
    try {
      await issueCode(record);
      // The code stays valid while this socket stays open.
      await record.sock?.closedPromise;
      if (record.linked || !isAlivePairing(record)) return;
      lastError = 'WhatsApp reset the pairing connection.';
    } catch (error) {
      if (!isAlivePairing(record)) return;
      lastError = error?.message || String(error);
      console.warn(`[Pairing ${record.number}] attempt ${attempt} failed: ${lastError}`);
    }

    if (isAlivePairing(record)) {
      record.status = 'reconnecting';
      record.message = 'WhatsApp reset the connection. Getting a fresh code — keep this page open…';
    }
    await sleep(Math.min(1500 + attempt * 1200, 8000));
  }

  if (isAlivePairing(record)) {
    failPairing(record, `Could not get a pairing code: ${lastError}`);
  }
}

// Restore only registered sessions that exist on this Render instance.
try {
  for (const folder of readdirSync(SESSIONS_DIR)) {
    const fullPath = join(SESSIONS_DIR, folder);
    if (statSync(fullPath).isDirectory() && isRegisteredOnDisk(folder)) {
      console.log(`[Auto-Start] Restoring local session: +${folder}`);
      startSession(folder).catch(err => console.error(`[Auto-Start ${folder}]`, err.message));
    }
  }
} catch (err) {
  console.error('[Auto-Start] Could not scan local sessions:', err.message);
}

console.log(`[Owner] Protected owner configured: +${OWNER_NUMBER}`);

// Web API
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'deny' }));

// Lightweight in-memory rate limiting; no database or external service needed.
const pairRateLimits = new Map();
function pairingRateLimit(req, res, next) {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 8;
  for (const [key, value] of pairRateLimits) {
    if (now - value.startedAt > 60 * 60 * 1000) pairRateLimits.delete(key);
  }
  const current = pairRateLimits.get(ip);
  if (!current || now - current.startedAt > windowMs) {
    pairRateLimits.set(ip, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > maxRequests) {
    return res.status(429).json({ error: 'Too many pairing requests. Try again in a few minutes.' });
  }
  return next();
}

app.post('/api/pair', pairingRateLimit, async (req, res) => {
  const number = normalizePhone(typeof req.body?.number === 'string' ? req.body.number : '');
  if (number.length < 10 || number.length > 15) {
    return res.status(400).json({ error: 'Valid phone number with country code is required (10-15 digits).' });
  }
  if (isRegisteredOnDisk(number)) {
    return res.status(409).json({ error: 'This number is already paired with the bot.' });
  }

  const current = pendingPairings.get(number);
  if (current && (isAlivePairing(current) || current.linked || current.status === 'open')) {
    return res.status(409).json({ error: 'A pairing request for this number is already active. Continue using the original pairing page.' });
  }

  const token = randomBytes(24).toString('hex');
  const record = {
    number,
    code: null,
    codeVersion: 0,
    status: 'generating',
    error: null,
    token,
    linked: false,
    cancelled: false,
    sock: null,
    deadline: Date.now() + PAIRING_TTL_MS
  };
  pendingPairings.set(number, record);
  runPairing(record).catch(err => failPairing(record, err?.message || 'Pairing failed.'));

  return res.json({ success: true, message: 'Pairing sequence initialized.', token });
});

app.get('/api/pair/status', (req, res) => {
  const number = normalizePhone(typeof req.query.number === 'string' ? req.query.number : '');
  const record = pendingPairings.get(number);
  if (!record) return res.status(404).json({ error: 'No pairing request found.' });

  const suppliedToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = Buffer.from(record.token || '');
  const supplied = Buffer.from(suppliedToken);
  if (!supplied.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: 'Pairing status access denied.' });
  }

  return res.json({
    number: record.number,
    code: record.code,
    status: record.status,
    error: record.error || null
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    activeSessions: activeSockets.size,
    ownerProtectionConfigured: Boolean(OWNER_NUMBER)
  });
});

app.listen(PORT, () => {
  console.log(`Obsidian Lock Core running on port ${PORT}`);
});
