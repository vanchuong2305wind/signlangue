/**
 * event-bus.js
 * Custom Event Bus for Speech-to-Sign pipeline.
 *
 * Events emitted:
 *   speech:interim  → { text }
 *   speech:final    → { text, confidence, timestamp, lang }
 *   speech:error    → { error, message }
 *   speech:silence  → { duration }
 *   speech:state    → { state }   // 'idle' | 'listening' | 'error'
 */

class EventBus {
  constructor() {
    this._target = new EventTarget();
  }

  /**
   * Subscribe to an event.
   * @param {string} eventName
   * @param {(detail: any) => void} callback
   */
  on(eventName, callback) {
    this._target.addEventListener(eventName, (e) => callback(e.detail));
  }

  /**
   * Unsubscribe from an event.
   * @param {string} eventName
   * @param {(detail: any) => void} callback
   */
  off(eventName, callback) {
    this._target.removeEventListener(eventName, callback);
  }

  /**
   * Emit an event with payload.
   * @param {string} eventName
   * @param {any} detail
   */
  emit(eventName, detail = {}) {
    this._target.dispatchEvent(new CustomEvent(eventName, { detail }));

    // Also dispatch on window so Step 3 can listen globally
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}

// Singleton instance
const eventBus = new EventBus();
export default eventBus;
