/**
 * speech-engine.js
 * Wrapper around Web Speech API (webkitSpeechRecognition).
 * Handles: browser compatibility, auto-restart on timeout, and routing results through the noise filter.
 *
 * A few browser realities shape this file:
 *  - A recognition object whose start() once failed stays unusable, so every
 *    session builds a fresh instance rather than reusing one for the page's life.
 *    Reusing one is what made the mic button dead until a page reload.
 *  - Android Chrome ends the session after each utterance whatever `continuous`
 *    says, so short sessions get restarted from onend.
 *  - iOS Safari needs a user gesture per session, so it is never auto-restarted.
 *  - The API only works in a secure context: https, or http on localhost.
 */

import eventBus from './event-bus.js';
import noiseFilter from './noise-filter.js';

const RESTART_DELAY_MS = 250;
// How long a user-requested stop is given to deliver its final result.
const GRACEFUL_STOP_MS = 3000;
// Generous, because it also covers the permission prompt being on screen.
const START_TIMEOUT_MS = 10000;
// Stops a restart loop when sessions are accepted but no speech ever arrives.
const MAX_SILENT_RESTARTS = 40;

const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
const IS_IOS = /iP(hone|ad|od)/i.test(UA)
  || (/Macintosh/.test(UA) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobile|IEMobile|Opera Mini/i.test(UA);

const ERROR_MESSAGES = {
  'not-allowed': 'Chưa cấp quyền microphone. Hãy kiểm tra cài đặt trình duyệt.',
  'service-not-allowed': 'Trình duyệt đang chặn nhận dạng giọng nói. Hãy cấp quyền microphone.',
  'network': 'Lỗi kết nối mạng. Web Speech API cần internet để hoạt động.',
  'audio-capture': 'Không tìm thấy microphone trên thiết bị.',
  'language-not-supported': 'Trình duyệt không hỗ trợ nhận dạng tiếng Việt. Hãy thử Chrome hoặc Edge bản mới.',
  'start-timeout': 'Không khởi động được microphone. Kiểm tra quyền micro rồi thử lại.',
  'insecure-context': 'Trang đang chạy qua HTTP nên trình duyệt chặn microphone. Hãy mở bằng HTTPS (hoặc localhost).',
  'not-supported': 'Trình duyệt không hỗ trợ Web Speech API. Hãy dùng Chrome hoặc Edge.',
};
// Routine everywhere: the engine heard nothing, or we aborted it ourselves.
// Every other code is reported — a swallowed code is why this could fail with
// no way to tell why.
const IGNORED_ERRORS = ['no-speech', 'aborted'];

class SpeechEngine {
  constructor() {
    this.recognition = null;
    this.lang = 'vi-VN';
    this.isSupported = !!this._getRecognitionCtor();
    this.isRecording = false;

    this._wantListening = false;
    this._session = 0;
    this._startTimer = null;
    this._restartTimer = null;
    this._endTimer = null;
    this._silentRestarts = 0;

    if (!this.isSupported) {
      console.warn('SpeechRecognition API is not supported in this browser.');
    }
  }

  _getRecognitionCtor() {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  /** Phones reach a dev server by LAN IP, where the mic is blocked outright. */
  _isSecureContext() {
    if (typeof window === 'undefined') return false;
    return window.isSecureContext !== false;
  }

  toggle() {
    if (!this.isSupported) {
      this._emitError('not-supported');
      return;
    }

    // Reads intent rather than isRecording: while a graceful stop is still
    // finishing, intent is already false, so a tap starts a new session.
    if (this._wantListening) {
      this.stop();
    } else {
      this.start();
    }
  }

  start() {
    if (!this.isSupported) {
      this._emitError('not-supported');
      return;
    }
    if (!this._isSecureContext()) {
      this._failFatally('insecure-context');
      return;
    }

    this._wantListening = true;
    this._silentRestarts = 0;
    noiseFilter.reset();
    this._beginSession();
  }

  stop() {
    this._wantListening = false;
    this._clearTimers();
    this.isRecording = false;
    noiseFilter.stopSilenceDetection();
    // Reported straight away: pressing stop should feel immediate, while the
    // handlers stay attached so a late final result still lands.
    eventBus.emit('speech:state', { state: 'idle' });

    const rec = this.recognition;
    if (!rec) {
      noiseFilter.reset();
      return;
    }

    try {
      // stop(), not abort(): the engine finishes the utterance it is holding and
      // delivers its final result. abort() would throw away the sentence the
      // user just spoke — the reason pressing stop lost the text entirely.
      rec.stop();
    } catch (err) {
      this._teardown();
      noiseFilter.reset();
      return;
    }

    // Bounded, so a session that never reports onend cannot linger.
    this._endTimer = setTimeout(() => {
      this._endTimer = null;
      if (this.recognition === rec) this._teardown();
    }, GRACEFUL_STOP_MS);
  }

  // --- Internals ---

  _clearTimers() {
    clearTimeout(this._startTimer);
    this._startTimer = null;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    clearTimeout(this._endTimer);
    this._endTimer = null;
  }

  /**
   * Drops the instance and makes any callback still in flight stale. Uses
   * abort(), which discards whatever the engine held — only for throwing a
   * session away, never for a stop the user asked for.
   */
  _teardown() {
    const rec = this.recognition;
    this.recognition = null;
    this._session += 1;
    if (!rec) return;
    rec.onstart = null;
    rec.onend = null;
    rec.onerror = null;
    rec.onresult = null;
    rec.onspeechend = null;
    try {
      rec.abort();
    } catch (err) {
      try { rec.stop(); } catch (err2) { /* already dead */ }
    }
  }

  _scheduleRestart(delay = RESTART_DELAY_MS) {
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._wantListening) this._beginSession();
    }, delay);
  }

  _emitError(code) {
    eventBus.emit('speech:error', {
      error: code,
      message: ERROR_MESSAGES[code] || `Lỗi Web Speech API: ${code}`,
    });
  }

  _failFatally(code) {
    this._wantListening = false;
    this._clearTimers();
    this._teardown();
    this.isRecording = false;
    noiseFilter.stopSilenceDetection();
    eventBus.emit('speech:state', { state: 'error' });
    this._emitError(code);
  }

  _beginSession() {
    const SpeechRecognition = this._getRecognitionCtor();
    if (!SpeechRecognition) return;

    this._teardown();
    this._clearTimers();

    const session = this._session;
    const rec = new SpeechRecognition();
    this.recognition = rec;
    const isStale = () => this._session !== session || this.recognition !== rec;

    rec.lang = this.lang;
    // Mobile engines end each utterance regardless of this flag, and asking for
    // continuous there is what left the first stop unrecoverable.
    rec.continuous = !IS_MOBILE;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      if (isStale()) return;
      clearTimeout(this._startTimer);
      this._startTimer = null;
      console.debug('[SpeechEngine] onstart — mic open, lang', rec.lang);
      this.isRecording = true;
      eventBus.emit('speech:state', { state: 'listening' });
      noiseFilter.startSilenceDetection();
    };

    rec.onresult = (event) => {
      if (isStale()) return;

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result || !result[0]) continue;

        const processed = noiseFilter.process(result);
        if (!processed.passed) continue;

        this._silentRestarts = 0;

        if (processed.isFinal) {
          console.debug(`[SpeechEngine] final (confidence ${processed.confidence}): "${processed.text}"`);
          eventBus.emit('speech:final', {
            text: processed.text,
            confidence: processed.confidence,
            timestamp: Date.now(),
            lang: rec.lang,
          });
        } else {
          eventBus.emit('speech:interim', { text: processed.text });
        }
        noiseFilter.startSilenceDetection();
      }
    };

    rec.onspeechend = () => {
      noiseFilter.startSilenceDetection();
    };

    rec.onerror = (event) => {
      if (isStale()) return;
      console.warn(`[SpeechEngine] Error: ${event.error}`, event.message || '');
      if (IGNORED_ERRORS.includes(event.error)) return;
      this._failFatally(event.error);
    };

    rec.onend = () => {
      if (isStale()) return;
      this.recognition = null;
      clearTimeout(this._startTimer);
      this._startTimer = null;
      clearTimeout(this._endTimer);
      this._endTimer = null;

      if (!this._wantListening) {
        this.isRecording = false;
        eventBus.emit('speech:state', { state: 'idle' });
        return;
      }

      // iOS only starts recognition from a real user gesture.
      if (IS_IOS) {
        this._wantListening = false;
        this.isRecording = false;
        eventBus.emit('speech:state', { state: 'idle' });
        return;
      }

      this._silentRestarts += 1;
      if (this._silentRestarts > MAX_SILENT_RESTARTS) {
        this._wantListening = false;
        this.isRecording = false;
        eventBus.emit('speech:state', { state: 'idle' });
        return;
      }

      console.debug('[SpeechEngine] Auto-stopped by browser. Restarting...');
      this._scheduleRestart();
    };

    try {
      rec.start();
    } catch (err) {
      // The instance is dead now; a fresh one is the only way back.
      console.warn('Recognition start error:', err);
      this._teardown();
      if (!this._wantListening) {
        this.isRecording = false;
        eventBus.emit('speech:state', { state: 'idle' });
        return;
      }
      this._silentRestarts += 1;
      if (this._silentRestarts > MAX_SILENT_RESTARTS) {
        this._failFatally('start-timeout');
        return;
      }
      this._scheduleRestart(RESTART_DELAY_MS * 2);
      return;
    }

    // Without this the UI could sit on "listening" while the mic never opened.
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      if (isStale() || this.isRecording) return;
      this._teardown();
      if (this._wantListening) this._failFatally('start-timeout');
      else eventBus.emit('speech:state', { state: 'idle' });
    }, START_TIMEOUT_MS);
  }
}

const speechEngine = new SpeechEngine();
export default speechEngine;
