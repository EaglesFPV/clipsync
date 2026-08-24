'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

/** In-memory clipboard history. No persistence by design: clipboard content can be sensitive. */
class ClipboardHub extends EventEmitter {
  constructor(maxSize = 25) {
    super();
    this.maxSize = maxSize;
    this.history = [];
  }

  addEntry({ text, source, deviceId = null, deviceName = 'PC' }) {
    const entry = { id: crypto.randomUUID(), text, source, deviceId, deviceName, ts: Date.now() };
    this.history.unshift(entry);
    if (this.history.length > this.maxSize) this.history.length = this.maxSize;
    this.emit('entry', entry);
    return entry;
  }

  getHistory() {
    return this.history.slice();
  }

  clear() {
    this.history = [];
  }
}

module.exports = { ClipboardHub };
