/**
 * text-display.js
 * Handles rendering interim/final text and JSON output.
 */

class TextDisplay {
  constructor() {
    this.interimTextEl = document.getElementById('interimText');
    this.historyListEl = document.getElementById('historyList');
    this.emptyHistoryMessageEl = document.getElementById('emptyHistoryMessage');
    this.jsonOutputEl = document.getElementById('jsonOutput');

    this.history = [];
  }

  /**
   * Show interim text while user is speaking.
   * @param {string} text
   */
  renderInterim(text) {
    if (this.interimTextEl) this.interimTextEl.textContent = text;
  }

  /**
   * Add final transcript to history and clear interim.
   * @param {{ text: string, confidence: number, timestamp: number, lang: string }} payload
   */
  renderFinal(payload) {
    const { text, confidence, timestamp, lang } = payload;

    // Clear interim line after final arrives
    if (this.interimTextEl) this.interimTextEl.textContent = '';

    // Update history state
    this.history.unshift({ text, confidence, timestamp, lang });

    // Keep max 30 lines to avoid huge DOM
    if (this.history.length > 30) {
      this.history = this.history.slice(0, 30);
    }

    this._renderHistoryList();
    this._renderJson(payload);
  }

  /**
   * Clear all displayed text/history.
   */
  clear() {
    if (this.interimTextEl) this.interimTextEl.textContent = '';
    this.history = [];
    this._renderHistoryList();
    this._renderJson({ text: '', confidence: 0, lang: 'vi-VN', timestamp: 0 });
  }

  _renderHistoryList() {
    if (!this.historyListEl) return;
    this.historyListEl.innerHTML = '';

    if (this.history.length === 0) {
      this.emptyHistoryMessageEl.classList.remove('hidden');
      return;
    }

    this.emptyHistoryMessageEl.classList.add('hidden');

    this.history.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'history-item bg-[#1a1d24] rounded px-3 py-2 flex items-center justify-between gap-3';

      const textWrap = document.createElement('div');
      textWrap.className = 'flex-1 min-w-0';

      const textEl = document.createElement('p');
      textEl.className = 'text-sm text-[#F8FAFC] truncate';
      textEl.textContent = item.text;

      const metaEl = document.createElement('p');
      metaEl.className = 'text-xs text-gray-500';
      const date = new Date(item.timestamp).toLocaleTimeString('vi-VN');
      metaEl.textContent = `${date} • ${(item.confidence * 100).toFixed(0)}%`;

      textWrap.appendChild(textEl);
      textWrap.appendChild(metaEl);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn text-xs px-2 py-1 rounded bg-[#1E293B] hover:bg-[#334155] transition-colors';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', `Copy văn bản số ${index + 1}`);

      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.text);
          copyBtn.textContent = '✓';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1200);
        } catch {
          copyBtn.textContent = 'Lỗi';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1200);
        }
      });

      row.appendChild(textWrap);
      row.appendChild(copyBtn);
      this.historyListEl.appendChild(row);
    });
  }

  _renderJson(payload) {
    if (this.jsonOutputEl) this.jsonOutputEl.textContent = JSON.stringify(payload, null, 2);
  }
}

const textDisplay = new TextDisplay();
export default textDisplay;
