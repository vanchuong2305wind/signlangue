/**
 * speech-engine.js
 * Wrapper around Web Speech API (webkitSpeechRecognition).
 * Handles: browser compatibility, auto-restart on timeout, and routing results through the noise filter.
 */

import eventBus from './event-bus.js';
import noiseFilter from './noise-filter.js';

class SpeechEngine {
  constructor() {
    this.recognition = null;
    this.isSupported = false;
    this.isRecording = false;
    this.intentionallyStopped = true;

    this._init();
  }

  _init() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn("SpeechRecognition API is not supported in this browser.");
      this.isSupported = false;
      return;
    }

    this.isSupported = true;
    this.recognition = new SpeechRecognition();

    // Configuration
    this.recognition.lang = 'vi-VN';
    this.recognition.continuous = true;     // Don't stop automatically when user stops speaking
    this.recognition.interimResults = true; // Give us real-time partial text
    this.recognition.maxAlternatives = 1;

    // Event Listeners
    this.recognition.onstart = this._handleStart.bind(this);
    this.recognition.onend = this._handleEnd.bind(this);
    this.recognition.onerror = this._handleError.bind(this);
    this.recognition.onresult = this._handleResult.bind(this);
    this.recognition.onspeechend = this._handleSpeechEnd.bind(this);
  }

  /**
   * Toggle recording state.
   */
  toggle() {
    if (!this.isSupported) {
      eventBus.emit('speech:error', { error: 'not-supported', message: 'Trình duyệt không hỗ trợ Web Speech API.' });
      return;
    }

    if (this.isRecording) {
      this.stop();
    } else {
      this.start();
    }
  }

  /**
   * Start listening for speech.
   */
  start() {
    if (!this.isSupported || this.isRecording) return;

    this.intentionallyStopped = false;
    try {
      this.recognition.start();
    } catch (err) {
      // If already started unexpectedly, just restart it cleanly
      console.warn('Recognition start error:', err);
      this.stop();
      setTimeout(() => this.start(), 200);
    }
  }

  /**
   * Stop listening.
   */
  stop() {
    if (!this.isSupported) return;

    this.intentionallyStopped = true;
    this.isRecording = false;
    noiseFilter.stopSilenceDetection();
    noiseFilter.reset();

    try {
      this.recognition.stop();
    } catch (err) {
      console.warn('Recognition stop error:', err);
    }

    eventBus.emit('speech:state', { state: 'idle' });
  }

  // --- Internal Event Handlers ---

  _handleStart() {
    this.isRecording = true;
    eventBus.emit('speech:state', { state: 'listening' });
    noiseFilter.startSilenceDetection();
  }

  _handleResult(event) {
    if (!this.isRecording) return;

    // Grab the latest result block
    const currentIndex = event.resultIndex;
    const result = event.results[currentIndex];

    // Pass through noise filter
    const processed = noiseFilter.process(result);

    if (!processed.passed) return;

    if (processed.isFinal) {
      eventBus.emit('speech:final', {
        text: processed.text,
        confidence: processed.confidence,
        timestamp: Date.now(),
        lang: this.recognition.lang
      });
      // Restart silence detection since they just finished a sentence
      noiseFilter.startSilenceDetection();
    } else {
      eventBus.emit('speech:interim', { text: processed.text });
      // Keep silence detection alive while receiving interim results
      noiseFilter.startSilenceDetection();
    }
  }

  _handleSpeechEnd() {
    // Fired when the user stops speaking.
    // If we're continuous, we shouldn't stop. Let noiseFilter handle the actual timeout.
    noiseFilter.startSilenceDetection();
  }

  _handleEnd() {
    // Web Speech API silently auto-stops after a few seconds of silence or after a single block in some browsers.
    // If we didn't stop it explicitly, restart it.
    if (!this.intentionallyStopped) {
      console.debug('[SpeechEngine] Auto-stopped by browser. Restarting...');
      setTimeout(() => {
        if (!this.intentionallyStopped) {
          try {
            this.recognition.start();
          } catch (e) {
             console.warn('Auto-restart failed:', e);
          }
        }
      }, 200);
    } else {
      this.isRecording = false;
      eventBus.emit('speech:state', { state: 'idle' });
    }
  }

  _handleError(event) {
    console.warn(`[SpeechEngine] Error: ${event.error}`);

    // Map common errors to user-friendly messages
    const errorMap = {
      'not-allowed': 'Chưa cấp quyền microphone. Hãy kiểm tra cài đặt trình duyệt.',
      'network': 'Lỗi kết nối mạng. Web Speech API cần internet để hoạt động.',
      'no-speech': null, // Ignore 'no-speech', handleEnd will restart it
      'audio-capture': 'Không tìm thấy microphone trên thiết bị.',
    };

    if (event.error === 'not-allowed' || event.error === 'audio-capture' || event.error === 'network') {
      this.stop(); // Fatal errors
      eventBus.emit('speech:state', { state: 'error' });
      eventBus.emit('speech:error', {
        error: event.error,
        message: errorMap[event.error] || `Lỗi Web Speech API: ${event.error}`
      });
    }
  }
}

const speechEngine = new SpeechEngine();
export default speechEngine;
