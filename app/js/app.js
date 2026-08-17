/**
 * app.js
 * Bootstrap application and wire all modules together.
 * Steps 2 + 3: Speech → Text → Sign Sequence
 */

import eventBus from './event-bus.js';
import speechEngine from './speech-engine.js';
import textDisplay from './text-display.js';
import textToSign from './text-to-sign.js';
import signDisplay from './sign-display.js';

class App {
  constructor() {
    this.micButton = document.getElementById('micButton');
    this.toggleButton = document.getElementById('toggleButton');
    this.statusText = document.getElementById('statusText');
    this.micIcon = document.getElementById('micIcon');
    this.compatibilityWarning = document.getElementById('compatibilityWarning');
    this.permissionError = document.getElementById('permissionError');

    this._init();
  }

  _init() {
    // Check browser compatibility
    if (!speechEngine.isSupported) {
      this.compatibilityWarning.classList.remove('hidden');
      this.toggleButton.disabled = true;
      this.toggleButton.classList.add('opacity-50', 'cursor-not-allowed');
      return;
    }

    // Initialize Step 3 modules
    textToSign.init();
    signDisplay.init();

    // Wire event listeners
    this._setupEventListeners();
    this._setupKeyboardShortcuts();
  }

  _setupEventListeners() {
    // Button clicks
    this.toggleButton.addEventListener('click', () => {
      speechEngine.toggle();
    });

    this.micButton.addEventListener('click', () => {
      speechEngine.toggle();
    });

    // Speech events
    eventBus.on('speech:state', ({ state }) => {
      this._updateUIState(state);
    });

    eventBus.on('speech:interim', ({ text }) => {
      textDisplay.renderInterim(text);
    });

    eventBus.on('speech:final', (payload) => {
      textDisplay.renderFinal(payload);
    });

    eventBus.on('speech:error', ({ error, message }) => {
      this._handleError(error, message);
    });

    eventBus.on('speech:silence', ({ duration }) => {
      console.debug(`[App] Silence detected: ${duration}ms`);
    });

    // Sign conversion events (Step 3)
    eventBus.on('sign:loading', ({ loading }) => {
      const pipeline = document.getElementById('pipelineStatus');
      if (pipeline) {
        pipeline.textContent = loading ? '⏳ Đang chuyển đổi...' : '';
      }
    });
  }

  _setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Space bar = toggle recording (only if not typing in an input)
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        speechEngine.toggle();
      }
    });
  }

  _updateUIState(state) {
    // Reset error states
    this.permissionError.classList.add('hidden');

    switch (state) {
      case 'listening':
        this.micButton.classList.remove('idle', 'error');
        this.micButton.classList.add('recording');
        this.toggleButton.textContent = 'DỪNG';
        this.statusText.textContent = 'Đang lắng nghe...';
        this.statusText.classList.remove('text-gray-400', 'text-red-400');
        this.statusText.classList.add('text-[#10B981]');
        break;

      case 'idle':
        this.micButton.classList.remove('recording', 'error');
        this.micButton.classList.add('idle');
        this.toggleButton.textContent = 'BẮT ĐẦU';
        this.statusText.textContent = 'Nhấn để bắt đầu';
        this.statusText.classList.remove('text-[#10B981]', 'text-red-400');
        this.statusText.classList.add('text-gray-400');
        textDisplay.renderInterim(''); // Clear interim
        break;

      case 'error':
        this.micButton.classList.remove('recording', 'idle');
        this.micButton.classList.add('error');
        this.toggleButton.textContent = 'BẮT ĐẦU';
        // Replaced by the real reason in _handleError, which fires right after.
        this.statusText.textContent = 'Lỗi microphone';
        this.statusText.classList.remove('text-gray-400', 'text-[#10B981]');
        this.statusText.classList.add('text-red-400');
        break;
    }
  }

  _handleError(error, message) {
    console.error(`[App] Error: ${error} - ${message}`);

    // Every code gets shown, not just the permission ones. Hiding the rest is
    // what made a network or unsupported-language failure look like nothing
    // happening at all.
    this.permissionError.classList.remove('hidden');
    this.permissionError.querySelector('p').textContent = `❌ ${message}`;
    this.statusText.textContent = message;
  }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}
