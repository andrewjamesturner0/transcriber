// Transcriber — local audio/video transcription
// Copyright (C) 2026 Andrew James Turner
// Licensed under the GNU General Public License v3.0
// See LICENSE for the full licence text.

/**
 * Transcription queue state model.
 *
 * Owns all queue state and transitions (pending -> processing -> done/error)
 * and serial-processing logic. Has no DOM dependencies — the renderer
 * wires lifecycle callbacks to update the UI.
 *
 * Design decisions (see todo-3-queue-model.md):
 *   D1 — createQueue() factory (matches existing codebase style)
 *   D2 — getActiveItem() exposes which item is being processed
 *   D3 — AbortSignal passed to processAll for cancellation
 */

/**
 * Create a new transcription queue.
 *
 * @returns {object} queue API
 */
function createQueue() {
  let _items = [];
  let _nextId = 0;
  let _activeId = null;
  let _running = false;

  // Copy before freezing so reads cannot freeze or change stored job results.
  function snapshot(value) {
    if (value === null || typeof value !== 'object') return value;
    const copy = Array.isArray(value) ? value.map(snapshot)
      : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)]));
    return Object.freeze(copy);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Add files to the queue. Each file is { filePath, fileName }. */
  function enqueue(files) {
    const added = [];
    for (const f of files) {
      const item = {
        id: _nextId++,
        filePath: f.filePath,
        fileName: f.fileName,
        status: 'pending',
        result: null,
        error: null,
      };
      _items.push(item);
      added.push(item);
    }
    return snapshot(added);
  }

  /**
   * Remove a single item. Only removes if the item is not currently
   * processing — pending, done, and error items can be removed.
   */
  function remove(id) {
    _items = _items.filter((item) => item.id !== id || item.status === 'processing');
  }

  /** Remove waiting work, keeping completed results and errors. */
  function clearPending() {
    _items = _items.filter((item) => item.status !== 'pending');
  }

  /** Remove retained work only when no batch is running. */
  function clearAll() {
    if (_running) throw new Error('Cannot clear all while the queue is running');
    _items = [];
    _activeId = null;
  }

  function isRunning() {
    return _running;
  }

  /** Return detached, read-only items, including nested result data. */
  function getSnapshot() {
    return snapshot(_items);
  }

  /** Return all items in queue order. */
  function getItems() {
    return getSnapshot();
  }

  /** Return summary counts. */
  function getSummary() {
    const done = _items.filter((i) => i.status === 'done').length;
    const total = _items.length;
    const pending = _items.filter((i) => i.status === 'pending').length;
    return { done, total, pending };
  }

  /** Return the item currently being processed, or null. */
  function getActiveItem() {
    if (_activeId == null) return null;
    return snapshot(_items.find((i) => i.id === _activeId) || null);
  }

  /**
   * Process all pending items serially.
   *
   * @param {Function} transcribeFn  - async (item) => result value
   * @param {object}   opts
   * @param {AbortSignal} [opts.signal]    - abort processing
   * @param {Function}    [opts.onChange]  - called after each status change
   * @returns {Promise<Array>} results in queue order
   */
  async function processAll(transcribeFn, opts = {}) {
    if (_running) throw new Error('The queue is already running');
    _running = true;
    const { signal, onChange } = opts;
    const results = [];
    const pendingIds = _items.filter((i) => i.status === 'pending').map((i) => i.id);

    try {
      for (const id of pendingIds) {
        if (signal && signal.aborted) break;
        const item = _items.find((i) => i.id === id && i.status === 'pending');
        if (!item) continue;

        _activeId = item.id;
        item.status = 'processing';
        item.error = null;

        try {
          if (onChange) onChange(snapshot(item));
          if (signal && signal.aborted) throw new Error('Cancelled');
          const result = await transcribeFn(snapshot(item));
          if (signal && signal.aborted) throw new Error('Cancelled');
          item.result = snapshot(result);
          item.status = 'done';
        } catch (err) {
          item.status = 'error';
          item.error = signal && signal.aborted ? 'Cancelled' : (err && err.message) || String(err);
        }

        _activeId = null;
        if (onChange) onChange(snapshot(item));
        results.push(snapshot({ item, status: item.status }));
      }
      return results;
    } finally {
      _activeId = null;
      _running = false;
    }
  }

  return {
    enqueue,
    remove,
    clearPending,
    clearAll,
    isRunning,
    getSnapshot,
    getItems,
    getSummary,
    getActiveItem,
    processAll,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createQueue };
} else {
  window.createQueue = createQueue;
}
