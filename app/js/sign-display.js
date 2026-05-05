/**
 * sign-display.js
 * Renders the sign symbol sequence in the UI.
 * Shows matched signs as chips, highlights unmatched words,
 * and provides visual feedback for the conversion pipeline.
 */

import eventBus from './event-bus.js';

class SignDisplay {
  constructor() {
    this.containerEl = document.getElementById('signSequenceContainer');
    this.outputEl = document.getElementById('signSequenceOutput');
    this.statsEl = document.getElementById('signStats');
    this.methodEl = document.getElementById('signMethod');
    this.loadingEl = document.getElementById('signLoading');
    this.signJsonEl = document.getElementById('signJsonOutput');
  }

  init() {
    eventBus.on('sign:sequence', (data) => this.renderSequence(data));
    eventBus.on('sign:loading', ({ loading }) => this.setLoading(loading));
    eventBus.on('sign:error', ({ message }) => this.renderError(message));
  }

  setLoading(loading) {
    if (this.loadingEl) {
      this.loadingEl.classList.toggle('hidden', !loading);
    }
  }

  renderSequence(data) {
    const { inputText, signs, foundCount, totalCount, method, fingerspellFallback } = data;

    // Stats
    if (this.statsEl) {
      const pct = totalCount > 0 ? Math.round((foundCount / totalCount) * 100) : 0;
      this.statsEl.textContent = `${foundCount}/${totalCount} từ tìm thấy (${pct}%)`;
      this.statsEl.className = `text-xs ${pct >= 70 ? 'text-emerald-400' : pct >= 40 ? 'text-amber-400' : 'text-red-400'}`;
    }

    // Method badge
    if (this.methodEl) {
      const isLLM = method === 'gemini';
      this.methodEl.textContent = isLLM ? '🤖 Gemini AI' : '📖 Rule-based';
      this.methodEl.className = `text-xs px-2 py-0.5 rounded ${isLLM ? 'bg-blue-900/50 text-blue-300' : 'bg-gray-700 text-gray-300'}`;
    }

    // Sign chips
    if (this.outputEl) {
      this.outputEl.innerHTML = '';

      signs.forEach((sign, idx) => {
        const chip = document.createElement('div');
        chip.className = sign.found
          ? 'sign-chip found'
          : 'sign-chip not-found';

        const viLabel = document.createElement('span');
        viLabel.className = 'sign-vi';
        viLabel.textContent = sign.vi;

        chip.appendChild(viLabel);

        if (sign.found && sign.gloss) {
          const glossLabel = document.createElement('span');
          glossLabel.className = 'sign-gloss';
          glossLabel.textContent = sign.gloss.toUpperCase();
          chip.appendChild(glossLabel);
        } else {
          const missLabel = document.createElement('span');
          missLabel.className = 'sign-miss';
          missLabel.textContent = '✗ không có';
          chip.appendChild(missLabel);
        }

        // Add arrow between chips
        if (idx < signs.length - 1) {
          const arrow = document.createElement('span');
          arrow.className = 'sign-arrow';
          arrow.textContent = '→';
          this.outputEl.appendChild(chip);
          this.outputEl.appendChild(arrow);
        } else {
          this.outputEl.appendChild(chip);
        }
      });

      // Show fingerspell fallback if any
      if (fingerspellFallback && fingerspellFallback.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'fingerspell-section';

        const label = document.createElement('p');
        label.className = 'text-xs text-gray-500 mt-3 mb-1';
        label.textContent = '🤟 Đánh vần cho từ không tìm thấy:';
        divider.appendChild(label);

        const fsContainer = document.createElement('div');
        fsContainer.className = 'flex flex-wrap gap-1';

        fingerspellFallback.forEach((letter) => {
          const lChip = document.createElement('span');
          lChip.className = letter.found
            ? 'sign-chip-mini found'
            : 'sign-chip-mini not-found';
          lChip.textContent = letter.gloss?.toUpperCase() || letter.vi;
          fsContainer.appendChild(lChip);
        });

        divider.appendChild(fsContainer);
        this.outputEl.appendChild(divider);
      }
    }

    // JSON output
    if (this.signJsonEl) {
      const jsonData = {
        input: inputText,
        method: method,
        sign_sequence: signs.filter(s => s.found).map(s => s.gloss),
        details: signs,
      };
      this.signJsonEl.textContent = JSON.stringify(jsonData, null, 2);
    }
  }

  renderError(message) {
    if (this.outputEl) {
      this.outputEl.innerHTML = `<p class="text-red-400 text-sm">❌ ${message}</p>`;
    }
  }
}

const signDisplay = new SignDisplay();
export default signDisplay;
