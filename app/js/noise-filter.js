/**
 * noise-filter.js
 * Filters out noise from Web Speech API results.
 *
 * Handles:
 *   - Low confidence transcripts
 *   - Too-short fragments (ambient noise)
 *   - Duplicate final transcripts
 *   - Silence detection with configurable timeout
 */

import eventBus from './event-bus.js';

// --- Constants ---
const CONFIDENCE_THRESHOLD = 0.6;   // Below this → discard (noisy result)
const MIN_TEXT_LENGTH = 2;          // Less than 2 chars → discard (ambient noise)
const SILENCE_TIMEOUT_MS = 2000;    // 2s no speech → emit silence event
const DEDUP_WINDOW_MS = 500;        // Window to detect duplicate submissions

class NoiseFilter {
  constructor() {
    this._lastFinalText = '';
    this._lastFinalTime = 0;
    this._silenceTimer = null;
  }

  /**
   * Process a SpeechRecognitionResult.
   * @param {SpeechRecognitionResult} result
   * @returns {{ passed: boolean, text: string, confidence: number, isFinal: boolean }}
   */
  process(result) {
    const isFinal = result.isFinal;
    const transcript = result[0].transcript.trim();
    const confidence = result[0].confidence ?? 1.0; // Some browsers omit confidence

    // Reset silence timer when we receive any result
    this._resetSilenceTimer();

    // Filter 1: Too short (ambient noise / breathing)
    if (transcript.length < MIN_TEXT_LENGTH) {
      return { passed: false, text: transcript, confidence, isFinal };
    }

    // Filter 2: Low confidence (for final results only — interim rarely has confidence)
    if (isFinal && confidence < CONFIDENCE_THRESHOLD) {
      console.debug(`[NoiseFilter] Discarded low-confidence: "${transcript}" (${confidence.toFixed(2)})`);
      return { passed: false, text: transcript, confidence, isFinal };
    }

    // Filter 3: Duplicate final transcripts within dedup window
    if (isFinal) {
      const now = Date.now();
      const isDuplicate =
        transcript === this._lastFinalText &&
        now - this._lastFinalTime < DEDUP_WINDOW_MS;

      if (isDuplicate) {
        console.debug(`[NoiseFilter] Discarded duplicate: "${transcript}"`);
        return { passed: false, text: transcript, confidence, isFinal };
      }

      this._lastFinalText = transcript;
      this._lastFinalTime = now;
    }

    return { passed: true, text: transcript, confidence, isFinal };
  }

  /**
   * Start silence detection timer.
   * Emits 'speech:silence' if no speech received within SILENCE_TIMEOUT_MS.
   */
  startSilenceDetection() {
    this._resetSilenceTimer();
    this._silenceTimer = setTimeout(() => {
      eventBus.emit('speech:silence', { duration: SILENCE_TIMEOUT_MS });
    }, SILENCE_TIMEOUT_MS);
  }

  /**
   * Cancel any running silence timer.
   */
  stopSilenceDetection() {
    this._resetSilenceTimer();
  }

  _resetSilenceTimer() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
  }

  /**
   * Reset internal state (call when stopping recognition).
   */
  reset() {
    this._lastFinalText = '';
    this._lastFinalTime = 0;
    this._resetSilenceTimer();
  }
}

const noiseFilter = new NoiseFilter();
export default noiseFilter;
