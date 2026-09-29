'use strict';
/**
 * audio-node.js — the CLI's only point of contact with real speakers/mic.
 *
 * Implements the exact same interface as the browser build's js/audio.js
 * (getSampleRate, requestMicrophone, startCapture, stopCapture,
 * getRecentSamples, play, hasMicPermission, releaseMicrophone) so
 * transmitter.js/receiver.js/file-transfer.js/calibration.js can run
 * completely unmodified on top of it. Everywhere the browser used
 * getUserMedia + Web Audio nodes, this uses the `sox` command-line tool as a
 * child process: `sox -d ...` to record from and play to the OS default
 * audio device. sox was chosen over a native Node audio addon (e.g.
 * node-gyp-built bindings) specifically because it needs no compiler
 * toolchain on the user's machine -- it's a single already-compiled binary
 * available via one line from each OS's normal package manager, which
 * matters a lot for a "paste one command, done" install.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Modem, Packet } = require('./core.js');

const SAMPLE_RATE = 48000;

/**
 * Which sox arguments select "the default audio device", for input or
 * output.
 *
 * Plain `-d` (SoX's own "default device" shorthand) is broken on Windows in
 * the specific SoX build (14.4.2, from SourceForge, last released 2015)
 * this project's installer points people at -- it fails with "Sorry, there
 * is no default audio device configured" even though a real default device
 * exists. This is a known, long-reported bug in that build's Windows
 * device-detection code, not anything specific to one machine; forcing the
 * Windows Multimedia driver explicitly (`-t waveaudio default`) instead of
 * SoX's own auto-detection is the documented workaround.
 *
 * Since exactly how well that workaround lands has varied across different
 * people's machines/audio drivers in reports of this bug, WAVEBYTE_SOX_DEVICE
 * is an escape hatch: set it to override the device args entirely, e.g.
 * (PowerShell)  $env:WAVEBYTE_SOX_DEVICE = "-t waveaudio 0"
 * to try a specific device index/name if "default" still doesn't work.
 */
function deviceArgs() {
  if (process.env.WAVEBYTE_SOX_DEVICE) {
    return process.env.WAVEBYTE_SOX_DEVICE.split(/\s+/).filter(Boolean);
  }
  if (process.platform === 'win32') return ['-t', 'waveaudio', 'default'];
  return ['-d'];
}

function soxAvailable() {
  try {
    const res = spawnSync('sox', ['--version'], { stdio: 'ignore' });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

function requireSox() {
  if (soxAvailable()) return;
  const msg = [
    "WaveByte needs the 'sox' command-line audio tool, and it isn't on your PATH.",
    '',
    '  macOS:          brew install sox',
    '  Debian/Ubuntu:  sudo apt-get install -y sox',
    '  Fedora:         sudo dnf install -y sox',
    '  Arch:           sudo pacman -S sox',
    '  Windows:        choco install sox.portable -y',
    '                  (no Chocolatey? download the SoX zip from',
    '                   https://sourceforge.net/projects/sox/files/sox/',
    '                   and add its folder to your PATH)',
    '',
    'Then run wavebyte again.',
  ].join('\n');
  throw new Error(msg);
}

const WBAudio = (() => {
  let recProc = null;
  let capturing = false;
  let micReady = false;
  let ringBuffer = null;
  let ringWritePos = 0;
  let ringFilled = false;
  let leftoverByte = null; // odd trailing byte between stdout chunks (16-bit samples can split across reads)

  /**
   * Same sizing logic (and same reasoning) as the browser build's
   * ringSecondsNeeded(): big enough to hold a full worst-case DATA_FRAME_LEN
   * transmission with margin, computed from the modem's actual timing so it
   * can never silently drift out of sync with modem.js/packet.js again.
   */
  function ringSecondsNeeded() {
    const worstCaseFrameSeconds = Modem.durationForByteLength(Packet.DATA_FRAME_LEN * 2);
    return worstCaseFrameSeconds * 1.5 + 3;
  }

  function getSampleRate() {
    return SAMPLE_RATE;
  }

  function writeChunkToRing(chunk) {
    if (!capturing || !ringBuffer) return;
    let buf = chunk;
    if (leftoverByte !== null) {
      buf = Buffer.concat([leftoverByte, chunk]);
      leftoverByte = null;
    }
    const sampleCount = Math.floor(buf.length / 2);
    const usableBytes = sampleCount * 2;
    if (usableBytes < buf.length) leftoverByte = buf.subarray(usableBytes);
    for (let i = 0; i < sampleCount; i++) {
      ringBuffer[ringWritePos] = buf.readInt16LE(i * 2) / 32768;
      ringWritePos = (ringWritePos + 1) % ringBuffer.length;
      if (ringWritePos === 0) ringFilled = true;
    }
  }

  /**
   * Starts a persistent `sox -d ...` recording subprocess once, streaming
   * raw 16-bit PCM from the OS default input device into a circular buffer.
   * Mirrors the browser's getUserMedia() call: called once per session,
   * guarded by hasMicPermission() everywhere it's used.
   */
  async function requestMicrophone() {
    requireSox();
    Modem.configure(SAMPLE_RATE);
    ringBuffer = new Float32Array(Math.ceil(ringSecondsNeeded() * SAMPLE_RATE));
    ringWritePos = 0;
    ringFilled = false;
    leftoverByte = null;

    return new Promise((resolve, reject) => {
      recProc = spawn(
        'sox',
        ['-q', ...deviceArgs(), '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed-integer', '-b', '16', '-c', '1', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let settled = false;
      let stderrBuf = '';

      recProc.stdout.on('data', (chunk) => {
        if (!settled) { settled = true; micReady = true; resolve(true); }
        writeChunkToRing(chunk);
      });
      recProc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
      recProc.on('error', (err) => {
        if (!settled) { settled = true; reject(new Error('MIC_PERMISSION_DENIED: could not start sox for recording (' + err.message + ')')); }
      });
      recProc.on('exit', (code) => {
        recProc = null;
        if (!settled && code !== 0) {
          settled = true;
          reject(new Error('MIC_PERMISSION_DENIED: sox recording exited immediately (code ' + code + '). ' + stderrBuf.trim() +
            '\nCheck that your OS actually has a default input (microphone) device available and permitted for terminal apps.'));
        }
      });
      // Some sox builds/devices buffer briefly before the first stdout chunk
      // even on total silence; don't hang the caller forever if so.
      setTimeout(() => { if (!settled) { settled = true; micReady = true; resolve(true); } }, 1000);
    });
  }

  function startCapture() { capturing = true; }
  function stopCapture() { capturing = false; }

  /** Returns the most recent `seconds` of captured audio, chronological order. Identical logic to the browser build. */
  function getRecentSamples(seconds) {
    if (!ringBuffer) return new Float32Array(0);
    const n = Math.min(Math.ceil(seconds * getSampleRate()), ringBuffer.length);
    const out = new Float32Array(n);
    if (!ringFilled && ringWritePos < n) {
      out.set(ringBuffer.subarray(0, ringWritePos), n - ringWritePos);
      return out;
    }
    for (let i = 0; i < n; i++) {
      const idx = (ringWritePos - n + i + ringBuffer.length * 4) % ringBuffer.length;
      out[i] = ringBuffer[idx];
    }
    return out;
  }

  function getAnalyser() { return null; } // no live spectrum view in the CLI build

  function makeWavBuffer(pcmData, sampleRate) {
    const numChannels = 1, bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmData.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmData.length, 40);
    return Buffer.concat([header, pcmData]);
  }

  /**
   * Play a Float32Array waveform through the speakers at the given volume
   * (0-1). Writes a short WAV file and hands it to `sox file -d` rather than
   * streaming raw PCM to a live sox process -- for these sub-10-second clips
   * a temp file is simpler and more robust than managing a second
   * long-running subprocess's stdin lifecycle, at a cost of a few ms of
   * temp-file I/O per packet that's irrelevant next to this modem's airtime.
   * @returns {Promise<void>} resolves when playback finishes
   */
  function play(waveform, volume = 0.6) {
    requireSox();
    const vol = Math.max(0, Math.min(1, volume));
    const pcm = Buffer.alloc(waveform.length * 2);
    for (let i = 0; i < waveform.length; i++) {
      let s = waveform[i] * vol;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      pcm.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    const wavBuf = makeWavBuffer(pcm, SAMPLE_RATE);
    const tmpFile = path.join(os.tmpdir(), `wavebyte-tx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    fs.writeFileSync(tmpFile, wavBuf);

    return new Promise((resolve, reject) => {
      const cleanup = () => fs.unlink(tmpFile, () => {});
      const p = spawn('sox', ['-q', tmpFile, ...deviceArgs()], { stdio: 'ignore' });
      p.on('error', (err) => { cleanup(); reject(new Error('Failed to play audio via sox: ' + err.message)); });
      p.on('exit', () => { cleanup(); resolve(); });
    });
  }

  function hasMicPermission() { return !!recProc && micReady; }

  function releaseMicrophone() {
    capturing = false;
    if (recProc) { try { recProc.kill(); } catch {} recProc = null; }
    micReady = false;
  }

  return {
    getSampleRate,
    requestMicrophone,
    startCapture,
    stopCapture,
    getRecentSamples,
    getAnalyser,
    play,
    hasMicPermission,
    releaseMicrophone,
  };
})();

module.exports = WBAudio;
