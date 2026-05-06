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
    return added;
  }

  /**
   * Remove a single item. Only removes if the item is not currently
   * processing — pending, done, and error items can be removed.
   */
  function remove(id) {
    _items = _items.filter((item) => item.id !== id || item.status === 'processing');
  }

  /**
   * Clear pending and error items. Items that are processing or already
   * done are preserved (they represent completed work during a run).
   */
  function clear() {
    _items = _items.filter((item) => item.status === 'processing' || item.status === 'done');
    if (_items.length === 0) _activeId = null;
  }

  /** Return all items in queue order. */
  function getItems() {
    return _items;
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
    return _items.find((i) => i.id === _activeId) || null;
  }

  /**
   * Process all pending items serially.
   *
   * @param {Function} transcribeFn  - async (item) => result string
   * @param {object}   opts
   * @param {AbortSignal} [opts.signal]    - abort processing
   * @param {Function}    [opts.onChange]  - called after each status change
   * @returns {Promise<Array>} results in queue order
   */
  async function processAll(transcribeFn, opts = {}) {
    const { signal, onChange } = opts;
    const results = [];
    const pending = _items.filter((i) => i.status === 'pending');

    for (const item of pending) {
      if (signal && signal.aborted) break;

      _activeId = item.id;
      item.status = 'processing';
      item.error = null;
      if (onChange) onChange(item);

      try {
        item.result = await transcribeFn(item);
        item.status = 'done';
      } catch (err) {
        item.status = 'error';
        item.error = err.message || String(err);
      }

      _activeId = null;
      if (onChange) onChange(item);
      results.push({ item, status: item.status });
    }

    return results;
  }

  return {
    enqueue,
    remove,
    clear,
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
