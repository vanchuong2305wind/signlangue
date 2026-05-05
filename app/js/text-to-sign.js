/**
 * text-to-sign.js
 * Step 3: Convert Vietnamese text → sign symbol sequence.
 *
 * Listens for 'speech:final' events, sends text to backend API,
 * and emits 'sign:sequence' with the resulting sign tokens.
 *
 * Events emitted:
 *   sign:sequence   → { inputText, signs, foundCount, totalCount, method }
 *   sign:loading    → { loading: boolean }
 *   sign:error      → { message }
 */

import eventBus from './event-bus.js';

const API_BASE = window.location.origin;

class TextToSign {
  constructor() {
    this._queue = [];
    this._processing = false;
  }

  init() {
    // Listen for final speech transcripts
    eventBus.on('speech:final', (payload) => {
      this._enqueue(payload.text);
    });
  }

  /**
   * Convert Vietnamese text to sign sequence via API.
   * @param {string} text
   * @returns {Promise<object>}
   */
  async convert(text) {
    eventBus.emit('sign:loading', { loading: true });

    try {
      const response = await fetch(`${API_BASE}/api/text-to-signs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, use_llm: true }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `API error: ${response.status}`);
      }

      const data = await response.json();

      eventBus.emit('sign:sequence', {
        inputText: data.input_text,
        signs: data.signs,
        foundCount: data.found_count,
        totalCount: data.total_count,
        method: data.method,
        fingerspellFallback: data.fingerspell_fallback || [],
      });

      return data;
    } catch (err) {
      console.error('[TextToSign] Error:', err);
      eventBus.emit('sign:error', { message: err.message });
      return null;
    } finally {
      eventBus.emit('sign:loading', { loading: false });
    }
  }

  _enqueue(text) {
    this._queue.push(text);
    if (!this._processing) {
      this._processQueue();
    }
  }

  async _processQueue() {
    this._processing = true;

    while (this._queue.length > 0) {
      const text = this._queue.shift();
      await this.convert(text);
    }

    this._processing = false;
  }
}

const textToSign = new TextToSign();
export default textToSign;
