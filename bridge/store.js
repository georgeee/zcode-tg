// Tiny durable JSON store: topic (Telegram message_thread_id) -> zcode
// session, plus the Telegram update offset so a restart doesn't reprocess
// or drop messages. Atomic write (tmp + rename) so a crash mid-write can't
// corrupt it.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const EMPTY = { updateOffset: undefined, topics: {} };

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
}
