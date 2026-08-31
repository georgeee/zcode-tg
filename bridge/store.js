// Tiny durable JSON store: topic (Telegram message_thread_id) -> zcode
// session, plus the Telegram update offset so a restart doesn't reprocess
// or drop messages. Atomic write (tmp + rename) so a crash mid-write can't
// corrupt it.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const EMPTY = { updateOffset: undefined, topics: {}, pendingPermissions: {} };

export class Store {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(EMPTY);
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
