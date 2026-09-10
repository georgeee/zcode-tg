// Tiny durable JSON store: topic (Telegram message_thread_id) -> zcode
// session, plus the Telegram update offset so a restart doesn't reprocess
// or drop messages. Atomic write (tmp + rename) so a crash mid-write can't
// corrupt it.
//
// Every write replaces the WHOLE in-memory snapshot on disk -- fine for one
// process, but if a second one ever points at the same path (e.g. the
// foreground `node bridge/index.js` testing flow README.md documents,
// started without stopping the systemd-managed instance first), each holds
// an independent copy from whenever it started and whichever saves last
// silently wins, discarding the other's topic/session mappings and update
// offset. A simple exclusive lock file makes a second instance against the
// same store fail fast and loudly instead.

import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';

const EMPTY = { updateOffset: undefined, topics: {}, pendingPermissions: {}, queues: {}, chats: {} };

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: no-op, just checks whether we could signal it
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by someone else -- treat as alive, can't tell otherwise
  }
}

// --- namespace-safe lock identity (2026-09-10 handout, crash-loop bug) ---
// A bare pid is not a safe identity for a lock file that survives restarts:
// in containers the pid namespace does not, so the recorded pid may name a
// LIVE-but-unrelated process in the new namespace, and the lock is never
// reclaimed -- the bridge crash-loops forever (observed on a production
// pod: 'pid 46' of a previous container vs whatever pid 46 is now). The
// fix is identity, not liveness: boot id + the holder's /proc start time
// alongside the pid. Same boot + same pid + same start time = same
// process (genuinely held); anything else = stale, reclaim.
export function lockIdentity(pid = process.pid) {
  return { pid, bootId: readBootId(), startTime: readProcStartTime(pid) };
}

export function readBootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return ''; // no /proc (exotic) -- fall back to pid-only matching
  }
}

// Field 22 of /proc/<pid>/stat (starttime, clock ticks since boot). Uniquely
// identifies a process within a boot; a recycled pid has a different one.
export function readProcStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2); // fields from state (3) onward
    return rest.split(' ')[19]; // field 22 overall
  } catch {
    return '';
  }
}

export function parseLockFile(text) {
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      if (Number.isInteger(j.pid)) return j;
    } catch {}
  }
  const pid = Number(trimmed);
  return Number.isInteger(pid) ? { pid } : { pid: NaN }; // legacy bare-pid lock
}

export function lockIsHeld(entry) {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  if (!isProcessAlive(entry.pid)) return false;
  // Legacy bare-pid lock: liveness is all we ever knew; keep the old
  // conservative behaviour (this is also the cross-namespace ambiguity the
  // new format exists to remove -- we cannot do better with what's on disk).
  if (entry.bootId == null) return true;
  const ident = lockIdentity(entry.pid);
  if (ident.bootId === '' || ident.startTime === '') return true; // can't verify -- conservative
  return ident.bootId === entry.bootId && ident.startTime === String(entry.startTime);
}

export class Store {
  constructor(path) {
    this.path = path;
    this._acquireLock();
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(EMPTY);
  }

  _acquireLock() {
    this.lockPath = `${this.path}.lock`;
    try {
      const fd = openSync(this.lockPath, 'wx'); // exclusive create, fails if it already exists
      writeFileSync(fd, JSON.stringify(lockIdentity()));
      closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const entry = parseLockFile(readFileSync(this.lockPath, 'utf8'));
      if (lockIsHeld(entry)) {
        const heldBy = entry.pid;
        throw new Error(
          `another instance already has ${this.path} open (pid ${heldBy}, lock at ${this.lockPath}). ` +
            `If that process is actually gone, delete the lock file and retry.`,
        );
      }
      // Stale lock from a process that no longer exists (e.g. kill -9,
      // never got to clean up) -- safe to reclaim.
      unlinkSync(this.lockPath);
      this._acquireLock();
      return;
    }
    const release = () => {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* already gone or never fully acquired -- fine either way */
      }
    };
    process.on('exit', release);
  }

  _save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  getOffset() {
    return this.data.updateOffset;
  }

  setOffset(offset) {
    this.data.updateOffset = offset;
    this._save();
  }

  getTopic(threadId) {
    return this.data.topics[threadId];
  }

  setTopic(threadId, entry) {
    this.data.topics[threadId] = { ...this.data.topics[threadId], ...entry };
    this._save();
  }

  // --- known group chats (default-target resolution for MCP session_create) ---
  // The Bot API cannot enumerate a bot's chats, so the bridge remembers every
  // group it has served (owner message seen, topic created, bot added).
  // Purely advisory metadata: bridge/chatpick.js re-validates each candidate
  // live via getChat before trusting it, so a stale entry is harmless.
  getChats() {
    return this.data.chats || {};
  }

  noteChat(chatId, info = {}) {
    if (!this.data.chats) this.data.chats = {};
    this.data.chats[chatId] = { ...this.data.chats[chatId], ...info };
    this._save();
  }

  // Tracked so an interactive permission prompt (AUTO_APPROVE_PERMISSIONS=false)
  // that's still awaiting a button press when the process dies isn't left
  // as an orphaned message with dead-but-still-clickable buttons forever --
  // on the next startup we can find it and clean it up (see index.js).
  addPendingPermission(requestId, entry) {
    if (!this.data.pendingPermissions) this.data.pendingPermissions = {};
    this.data.pendingPermissions[requestId] = entry;
    this._save();
  }

  removePendingPermission(requestId) {
    if (!this.data.pendingPermissions) return;
    delete this.data.pendingPermissions[requestId];
    this._save();
  }

  getAllPendingPermissions() {
    return this.data.pendingPermissions || {};
  }

  // --- per-topic message queue (messages sent while a turn was running) ---
  // Persisted for the same reason as everything else here: a restart between
  // "queued" and "processed" shouldn't silently swallow what the user sent.
  // Each item carries the Telegram message_id of its "queued" notice, which
  // becomes the turn's placeholder when the item is dequeued -- so even after
  // a restart the reply lands on the message the user saw accepted.
  getQueues() {
    return this.data.queues || {};
  }

  getQueue(threadId) {
    return (this.data.queues || {})[threadId] || [];
  }

  setQueue(threadId, items) {
    if (!this.data.queues) this.data.queues = {};
    if (items.length) this.data.queues[threadId] = items;
    else delete this.data.queues[threadId]; // don't accumulate empty arrays
    this._save();
  }
}
