/**
 * ui.js — small presentation helpers. No protocol logic lives here.
 */

const UI = (() => {
  function $(id) { return document.getElementById(id); }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }

  function formatBitrate(bytes, seconds) {
    if (!seconds || seconds <= 0) return '—';
    const bps = (bytes * 8) / seconds;
    if (bps < 1000) return `${bps.toFixed(1)} bps`;
    return `${(bps / 1000).toFixed(2)} kbps`;
  }

  function setStatus(state, text) {
    const pill = $('globalStatus');
    pill.dataset.state = state;
    pill.querySelector('.status-text').textContent = text;
  }

  function setLiveStatus(text) {
    $('liveStatus').textContent = text;
  }

  const STATUS_LABELS = {
    LISTENING: 'Listening…',
    SYNCHRONIZING: 'Synchronizing…',
    RECEIVING: 'Receiving…',
    PACKET_VERIFIED: 'Packet verified',
    PACKET_CORRUPTED: 'Packet corrupted',
    RECONSTRUCTING: 'Reconstructing file…',
    VERIFYING: 'Verifying integrity…',
    TRANSFER_COMPLETE: 'Transfer complete',
    TRANSFER_FAILED: 'Transfer failed',
    SENDING_HELLO: 'Sending HELLO…',
    SENDING_CAPABILITIES: 'Sending capabilities…',
    SENDING_START_TRANSFER: 'Starting transfer…',
    SENDING_DATA: 'Transmitting data…',
    SENDING_END_TRANSFER: 'Sending integrity hash…',
  };

  function friendlyStatus(raw) {
    return STATUS_LABELS[raw] || raw;
  }

  function log(message, kind = '') {
    const logEl = $('protocolLog');
    const line = document.createElement('div');
    line.className = `log-line${kind ? ' ' + kind : ''}`;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    line.textContent = `[${time}] ${message}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function switchMode(mode) {
    document.querySelectorAll('.mode-btn').forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== mode;
    });
  }

  return { $, formatBytes, formatDuration, formatBitrate, setStatus, setLiveStatus, friendlyStatus, log, switchMode };
})();
