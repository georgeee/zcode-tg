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

const EMPTY = { updateOffset: undefined, topics: {}, pendingPermissions: {} };

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: no-op, just checks whether we could signal it
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by someone else -- treat as alive, can't tell otherwise
  }
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
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const heldBy = Number(readFileSync(this.lockPath, 'utf8').trim());
      if (isProcessAlive(heldBy)) {
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
}
