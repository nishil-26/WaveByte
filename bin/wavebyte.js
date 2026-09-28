#!/usr/bin/env node
'use strict';
/**
 * bin/wavebyte.js — CLI entry point.
 *
 * Usage:
 *   wavebyte                     interactive menu
 *   wavebyte send <file> [opts]  send a file (or .txt as a text message)
 *   wavebyte text [opts]         type and send short text messages
 *   wavebyte receive [opts]      listen for one incoming transfer
 *   wavebyte calibrate           one-button channel calibration
 *   wavebyte -h | --help
 *   wavebyte -v | --version
 *
 * Options:
 *   --volume <0-100>   transmit volume, default 60
 *   --out <dir>        directory to save received files into, default: cwd
 */
const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const { FileTransfer, Calibration } = require('../lib/protocol.js');
const WBAudio = require('../lib/audio-node.js');
const { Modem, Packet } = require('../lib/core.js');
const tui = require('../lib/tui.js');
const pkg = require('../package.json');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--volume') opts.volume = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else opts._.push(a);
  }
  return opts;
}

function volumeFromOpt(opts) {
  if (opts.volume === undefined || isNaN(opts.volume)) return 0.6;
  return Math.max(0.1, Math.min(1, opts.volume / 100));
}

async function ensureMic() {
  if (!WBAudio.hasMicPermission()) {
    tui.log('Starting microphone capture (via sox)...');
    await WBAudio.requestMicrophone();
    tui.log('Microphone ready.', 'success');
  }
}

function makeCallbacks(direction, totals) {
  let currentStatus = 'STARTING';
  return {
    onStatus: (s) => { currentStatus = s; tui.liveLine(tui.statusLine(currentStatus, totals.lastStats || {}, totals)); },
    onStatsUpdate: (stats) => { totals.lastStats = stats; tui.liveLine(tui.statusLine(currentStatus, stats, totals)); },
    onLog: (msg) => { tui.endLiveLine(); tui.log(msg); },
    onMeta: (meta) => {
      tui.endLiveLine();
      tui.log(`Incoming: "${meta.filename}" — ${tui.formatBytes(meta.size)}${meta.isText ? ' (text message)' : ''}`, 'success');
      totals.totalPackets = meta.totalPackets;
      totals.bytesTotal = meta.size;
      totals.filename = meta.filename;
      totals.isText = meta.isText;
    },
  };
}

// ---------------------------------------------------------------- send ----
async function cmdSend(filePath, opts) {
  if (!filePath) { tui.log('Usage: wavebyte send <file> [--volume 0-100]', 'error'); process.exit(1); }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) { tui.log(`File not found: ${resolved}`, 'error'); process.exit(1); }
  const dataBytes = new Uint8Array(fs.readFileSync(resolved));
  const isText = path.extname(resolved).toLowerCase() === '.txt';
  const meta = { filename: path.basename(resolved), isText };
  const volume = volumeFromOpt(opts);

  tui.banner(`sending ${meta.filename}  (${tui.formatBytes(dataBytes.length)})`);
  await ensureMic(); // not strictly needed to transmit, but ACK/NACK replies must be heard
  WBAudio.startCapture();

  const totals = { direction: 'send', bytesTotal: dataBytes.length };
  const t0 = Date.now();
  const result = await FileTransfer.send(dataBytes, meta, makeCallbacks('send', totals), { volume });
  tui.endLiveLine();

  if (result.success) {
    const secs = (Date.now() - t0) / 1000;
    tui.log(`Done in ${tui.formatDuration(secs)} (${tui.formatBitrate(dataBytes.length, secs)}). SHA-256: ${result.hash}`, 'success');
  } else {
    tui.log(`Transfer failed: ${result.reason}`, 'error');
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------- receive ----
async function cmdReceive(opts) {
  const outDir = opts.out ? path.resolve(opts.out) : process.cwd();
  const volume = volumeFromOpt(opts);
  tui.banner('listening for an incoming transfer — leave this running on the receiving laptop');
  await ensureMic();
  WBAudio.startCapture();

  const totals = { direction: 'receive' };
  const result = await FileTransfer.receive(makeCallbacks('receive', totals), { volume });
  tui.endLiveLine();

  if (!result.success && !result.bytes) {
    tui.log(`Receive failed: ${result.reason}`, 'error');
    process.exitCode = 1;
    return;
  }

  if (result.meta && result.meta.isText) {
    tui.log('Message: ' + tui.color.bold(Buffer.from(result.bytes).toString('utf8')), 'success');
  } else if (result.meta) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, result.meta.filename || 'received.bin');
    fs.writeFileSync(outPath, Buffer.from(result.bytes));
    tui.log(`Saved: ${outPath} (${tui.formatBytes(result.bytes.length)})`, 'success');
  }

  if (result.hashMatch) tui.log('Integrity verified (SHA-256 match).', 'success');
  else tui.log('WARNING: integrity hash did NOT match — file may be corrupted.', 'warn');
}

// ------------------------------------------------------------------ text ----
async function cmdText(opts) {
  const volume = volumeFromOpt(opts);
  const rl = readline.createInterface({ input, output });
  tui.banner('text messages — type a line and press Enter to send it');
  await ensureMic();
  WBAudio.startCapture();
  try {
    for (;;) {
      const line = await rl.question(tui.color.cyan('message> '));
      if (line === '') continue;
      if (line === '/quit' || line === '/exit') break;
      const bytes = new TextEncoder().encode(line);
      const totals = { direction: 'send', bytesTotal: bytes.length };
      const result = await FileTransfer.send(bytes, { filename: 'message.txt', isText: true }, makeCallbacks('send', totals), { volume });
      tui.endLiveLine();
      if (result.success) tui.log('Sent.', 'success');
      else tui.log(`Send failed: ${result.reason}`, 'error');
    }
  } finally {
    rl.close();
  }
}

// ------------------------------------------------------------- calibrate ----
async function cmdCalibrate() {
  tui.banner('channel calibration — plays each carrier tone briefly and listens back through this laptop only');
  await ensureMic();
  const result = await Calibration.run(({ stage, progress, freq }) => {
    tui.liveLine(`${tui.progressBar(progress)}  ${tui.color.dim(stage)}${freq ? ' ' + freq + 'Hz' : ''}`);
  });
  tui.endLiveLine();
  tui.log(`Noise floor: ${result.noiseFloor.toExponential(2)}`);
  tui.log(`Estimated SNR: ${result.snrEstimateDb.toFixed(1)} dB`);
  tui.log(`Tone-response flatness: ${(result.flatness * 100).toFixed(0)}% (100% = perfectly even across all carrier tones)`);
  tui.log(`Suggested transmit volume: ${Math.round(result.suggestedVolume * 100)}%`);
  if (result.weakTones.length) {
    tui.log(`Weak tones (consider they may not carry reliably on this hardware): ${result.weakTones.join(', ')} Hz`, 'warn');
  } else {
    tui.log('All carrier tones responded within a healthy range.', 'success');
  }
}

// ------------------------------------------------------------------ menu ----
async function interactiveMenu() {
  const rl = readline.createInterface({ input, output });
  tui.banner(`v${pkg.version} — no Wi-Fi, no Bluetooth, no internet: data travels as sound`);
  try {
    for (;;) {
      console.log([
        '  1) Send a file',
        '  2) Receive',
        '  3) Text chat',
        '  4) Calibrate channel',
        '  5) Quit',
      ].join('\n'));
      const choice = (await rl.question('\n> ')).trim();
      console.log('');
      try {
        if (choice === '1') {
          const p = (await rl.question('File path to send: ')).trim();
          const volPct = (await rl.question('Volume 10-100 [60]: ')).trim();
          await cmdSend(p, { volume: volPct ? Number(volPct) : undefined });
        } else if (choice === '2') {
          const outDir = (await rl.question(`Save into folder [${process.cwd()}]: `)).trim();
          await cmdReceive({ out: outDir || undefined });
        } else if (choice === '3') {
          await cmdText({});
        } else if (choice === '4') {
          await cmdCalibrate();
        } else if (choice === '5' || choice.toLowerCase() === 'q') {
          break;
        } else {
          console.log('Not a valid option.\n');
          continue;
        }
      } catch (err) {
        tui.endLiveLine();
        tui.log(err.message, 'error');
      }
      console.log('');
    }
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`wavebyte v${pkg.version}

Usage:
  wavebyte                     interactive menu
  wavebyte send <file>         send a file (.txt is sent as a text message)
  wavebyte text                type and send short text messages, one per line
  wavebyte receive             listen for one incoming transfer
  wavebyte calibrate           one-button channel calibration (run alone first)
  wavebyte -h, --help          this message
  wavebyte -v, --version       print the version

Options (send/receive/text):
  --volume <0-100>   transmit volume, default 60
  --out <dir>         (receive only) directory to save into, default: current directory

Both laptops need WaveByte installed and running -- there is no server, no
pairing, and no network traffic of any kind between them. Run "wavebyte
calibrate" on each laptop once, alone, before your first real transfer.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();
  if (opts.version) return console.log(pkg.version);

  const cmd = opts._[0];
  process.on('SIGINT', () => { tui.endLiveLine(); tui.log('Interrupted.', 'warn'); WBAudio.releaseMicrophone(); process.exit(130); });

  try {
    if (!cmd) await interactiveMenu();
    else if (cmd === 'send') await cmdSend(opts._[1], opts);
    else if (cmd === 'receive') await cmdReceive(opts);
    else if (cmd === 'text') await cmdText(opts);
    else if (cmd === 'calibrate') await cmdCalibrate();
    else { console.error(`Unknown command: ${cmd}\n`); printHelp(); process.exitCode = 1; }
  } finally {
    WBAudio.releaseMicrophone();
  }
}

main().catch((err) => {
  tui.endLiveLine();
  tui.log(err.message, 'error');
  process.exitCode = 1;
});
