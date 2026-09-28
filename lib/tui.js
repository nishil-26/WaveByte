'use strict';
/**
 * tui.js — terminal presentation helpers, no protocol logic lives here.
 * Deliberately has zero npm dependencies (no chalk/blessed/ink) so
 * `npm install -g` has nothing extra that can fail to build or fetch.
 */

const isTTY = process.stdout.isTTY;
const NO_COLOR = !!process.env.NO_COLOR;

function paint(code, s) {
  if (!isTTY || NO_COLOR) return s;
  return `\u001b[${code}m${s}\u001b[0m`;
}
const color = {
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
  cyan: (s) => paint('36', s),
  green: (s) => paint('32', s),
  yellow: (s) => paint('33', s),
  red: (s) => paint('31', s),
  magenta: (s) => paint('35', s),
};

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

function banner(subtitle) {
  console.log(color.cyan(color.bold('\n  WAVEBYTE')) + color.dim('  ·  near-ultrasonic acoustic data link'));
  if (subtitle) console.log('  ' + color.dim(subtitle));
  console.log('');
}

function log(message, kind = 'info') {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const prefix = color.dim(`[${time}]`);
  let line = `${prefix} ${message}`;
  if (kind === 'error') line = `${prefix} ${color.red(message)}`;
  else if (kind === 'success') line = `${prefix} ${color.green(message)}`;
  else if (kind === 'warn') line = `${prefix} ${color.yellow(message)}`;
  console.log(line);
}

function progressBar(fraction, width = 28) {
  const f = Math.max(0, Math.min(1, isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${color.cyan(bar)} ${(f * 100).toFixed(0).padStart(3)}%`;
}

/** Overwrites the current terminal line -- used for a live-updating status/progress readout. */
let lastLiveLen = 0;
function liveLine(text) {
  if (!isTTY) { console.log(text); return; }
  const pad = Math.max(0, lastLiveLen - text.length);
  process.stdout.write('\r' + text + ' '.repeat(pad));
  lastLiveLen = text.length;
}
function endLiveLine() {
  if (isTTY) process.stdout.write('\n');
  lastLiveLen = 0;
}

function statusLine(status, stats, totals) {
  const pct = totals.direction === 'send'
    ? (totals.bytesTotal ? (stats.bytesAcked || 0) / totals.bytesTotal : 0)
    : (totals.totalPackets ? (stats.packetsReceived || 0) / totals.totalPackets : 0);
  const bar = progressBar(pct);
  const extra = totals.direction === 'send'
    ? `sent ${stats.packetsSent || 0}  acked ${stats.packetsAcked || 0}  retx ${stats.retransmissions || 0}  round ${stats.rounds || 0}`
    : `recv ${stats.packetsReceived || 0}/${totals.totalPackets || '?'}  crc-err ${stats.crcErrors || 0}  fec-fix ${stats.packetsRecovered || 0}  retx ${stats.retransmissions || 0}`;
  return `${bar}  ${color.dim(status.padEnd(22))} ${color.dim(extra)}`;
}

module.exports = {
  color, formatBytes, formatDuration, formatBitrate,
  banner, log, progressBar, liveLine, endLiveLine, statusLine,
  isTTY,
};
