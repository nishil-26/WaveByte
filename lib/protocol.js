'use strict';
// GENERATED FILE -- do not edit directly.
// Built by build/make-protocol-bundle.js from lib/protocol-src/*.js.
// Those source files are copied unchanged from WaveByte's browser js/
// files -- same HELLO/CAPABILITIES/START_TRANSFER/DATA/ACK-NACK/END_TRANSFER
// state machine, same ARQ/FEC/CRC/SHA-256 logic -- on top of core.js and
// this CLI's sox-backed audio-node.js in place of the browser's Web Audio
// layer.
const { CRC32, FEC, Packet, PacketType, Goertzel, Modem, SHA256 } = require('./core.js');
const WBAudio = require('./audio-node.js');

// ---- lib/protocol-src/transmitter.js ----
/**
 * transmitter.js — turns a packet into an acoustic transmission.
 */

const Transmitter = (() => {
  /**
   * @param {Uint8Array} framedPacket - output of Packet.create()
   * @param {number} volume - 0-1
   * @returns {Promise<void>}
   */
  async function sendPacket(framedPacket, volume = 0.6) {
    const encoded = FEC.encode(framedPacket);
    const waveform = Modem.modulate(encoded);
    await WBAudio.play(waveform, volume);
  }

  function activeTonesFor(framedPacket) {
    // For spectrum-diagnostic display: show the full tone set that could appear.
    return [Modem.PILOT_FREQ, ...Modem.DATA_TONES];
  }

  return { sendPacket, activeTonesFor };
})();


// ---- lib/protocol-src/receiver.js ----
/**
 * receiver.js — turns captured microphone audio into parsed, verified packets.
 *
 * listenForPacket() is the shared primitive used both by RECEIVE mode
 * (passively waiting for an incoming transfer) and by the transmitter
 * (waiting for an ACK/NACK after sending). It knows the fixed frame length
 * to expect because the protocol state machine always knows what packet
 * type(s) can legally arrive next (see docs/protocol.md).
 */

/**
 * Live diagnostics snapshot, updated on every demodulated symbol block.
 * Polled by the UI dashboard rather than threaded through every callback.
 */
const Diagnostics = { offsetHz: 0, confidence: 0, lastUpdate: 0 };

const Receiver = (() => {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @param {number} timeoutMs
   * @param {number} frameLenBytes - Packet.CONTROL_FRAME_LEN or Packet.DATA_FRAME_LEN
   * @param {object} [opts]
   * @param {function} [opts.onStatus] - callback(status: string) for UI state updates
   * @returns {Promise<{packet: object|null, offsetHz: number, corrected: number, confidence: number, timedOut: boolean, corrupted: boolean}>}
   */
  async function listenForPacket(timeoutMs, frameLenBytes, opts = {}) {
    const { onStatus } = opts;
    if (!WBAudio.hasMicPermission()) {
      await WBAudio.requestMicrophone();
    }
    WBAudio.startCapture();
    onStatus && onStatus('LISTENING');

    const encodedLen = frameLenBytes * 2; // FEC(7,4) on nibbles doubles byte count
    const totalDuration = Modem.durationForByteLength(encodedLen); // seconds, chirp + symbols
    const symCount = Modem.symbolsForByteLength(encodedLen);
    const pollInterval = 55; // ms
    const deadline = performance.now() + timeoutMs;

    while (performance.now() < deadline) {
      await sleep(pollInterval);
      const bufSeconds = totalDuration + 0.35;
      const buf = WBAudio.getRecentSamples(bufSeconds);
      const gateIdx = Modem.detectChirp(buf); // cheap gate: is a transmission underway at all?
      if (gateIdx < 0) continue;

      onStatus && onStatus('SYNCHRONIZING');

      // Wait until enough trailing samples have actually arrived in the ring buffer.
      const capturedAfterChirpMs = ((buf.length - gateIdx) / WBAudio.getSampleRate()) * 1000;
      const stillNeededMs = totalDuration * 1000 - capturedAfterChirpMs;
      if (stillNeededMs > 0) await sleep(stillNeededMs + 70);

      // Grab a fresh buffer now that enough time has passed, re-gate on it,
      // and hand demodulate() a region with margin before that coarse guess —
      // synchronize() inside demodulate() will find the precise time+frequency
      // alignment itself, since a shifted chirp can land a bit off from this
      // coarse gate.
      const buf2 = WBAudio.getRecentSamples(bufSeconds + 0.3);
      const gateIdx2 = Modem.detectChirp(buf2);
      if (gateIdx2 < 0) continue; // lost lock, keep polling until timeout

      const marginSamples = Math.round(0.15 * WBAudio.getSampleRate());
      const regionStart = Math.max(0, gateIdx2 - Modem.chirpSamples() - marginSamples);
      const region = buf2.subarray(regionStart);

      onStatus && onStatus('RECEIVING');
      const demodRes = Modem.demodulate(region, symCount);
      Diagnostics.offsetHz = demodRes.offsetHz;
      Diagnostics.confidence = demodRes.avgConfidence;
      Diagnostics.lastUpdate = performance.now();

      if (demodRes.bytes.length === 0) continue; // sync failed on this attempt, keep polling

      const fecRes = FEC.decode(demodRes.bytes);
      const parsed = Packet.parse(fecRes.bytes);

      if (parsed && parsed.valid) {
        onStatus && onStatus('PACKET_VERIFIED');
        return {
          packet: parsed,
          offsetHz: demodRes.offsetHz,
          corrected: fecRes.correctedCount,
          confidence: demodRes.avgConfidence,
          timedOut: false,
          corrupted: false,
        };
      }

      onStatus && onStatus('PACKET_CORRUPTED');
      return {
        packet: null,
        offsetHz: demodRes.offsetHz,
        corrected: fecRes.correctedCount,
        confidence: demodRes.avgConfidence,
        timedOut: false,
        corrupted: true,
      };
    }

    return { packet: null, offsetHz: 0, corrected: 0, confidence: 0, timedOut: true, corrupted: false };
  }

  return { listenForPacket };
})();


// ---- lib/protocol-src/file-transfer.js ----
/**
 * file-transfer.js — the protocol state machine described in docs/protocol.md.
 *
 * SEND:    HELLO -> CAPABILITIES -> START_TRANSFER -> DATA... -> (NACK/ACK
 *          rounds) -> END_TRANSFER(hash) -> final ACK/NACK
 * RECEIVE: mirror of the above, passively from IDLE/LISTENING.
 *
 * Text messages and binary files both flow through this same pipeline —
 * text is just a "file" with an isText flag, which buys chat messages the
 * same CRC+FEC+ARQ+SHA-256 reliability as file transfers for free.
 */

const FileTransfer = (() => {
  const MAX_NAME_BYTES = 24;
  const CHUNK_SIZE = Packet.MAX_PAYLOAD; // 64 bytes
  // Max missing-sequence entries a single NACK can list: floor((MAX_PAYLOAD-1)/2).
  // Bigger MAX_PAYLOAD (see packet.js) means each NACK can now cover more
  // missing packets per round, which matters more as file size (and so
  // packet count) grows.
    const NACK_MAX_ENTRIES = Math.floor((Packet.MAX_PAYLOAD - 1) / 2);

  /**
   * Wait-timeout for a listenForPacket() call expecting a frame of this
   * size, derived from the modem's own timing instead of a hand-picked
   * constant.
   *
   * THIS REPLACES SEVERAL HARDCODED TIMEOUTS (5000/6000/8000/10000ms) THAT
   * WERE A SECOND CRITICAL BUG: a DATA_FRAME_LEN packet's on-air duration
   * (Modem.durationForByteLength(Packet.DATA_FRAME_LEN * 2)) was already
   * ~6.7s with the original tuning and is ~9.2s with this build's -- and
   * every exchange past the initial HELLO (CAPABILITIES, START_TRANSFER,
   * DATA, ACK/NACK, END_TRANSFER) is DATA_FRAME_LEN-sized. A 6-second
   * timeout on a listen whose *reply alone* takes ~9.2s to arrive means the
   * receiver (or the sender waiting on a reply) gives up and reports failure
   * before the other side has even finished transmitting -- for literally
   * every real transfer, regardless of file type, size, or content. Deriving
   * the timeout from the actual frame timing means it can never again
   * silently fall out of sync with modem.js/packet.js.
   */
  function waitTimeoutFor(frameLenBytes) {
    const airtimeMs = Modem.durationForByteLength(frameLenBytes * 2) * 1000;
    return airtimeMs * 1.5 + 3000; // 50% headroom + a flat 3s margin for capture/processing latency
  }

  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }
  function utf8Decode(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, false); }
  function u16(view, offset, value) { view.setUint16(offset, value & 0xFFFF, false); }

  // ============================= SEND =============================

  /**
   * @param {Uint8Array} dataBytes - raw content to send (text UTF-8 bytes or file bytes)
   * @param {object} meta - { filename, mimeType, isText }
   * @param {object} cb - callbacks: onStatus(str), onStatsUpdate(obj), onLog(str)
   * @param {object} opts - { volume }
   * @returns {Promise<{success: boolean, reason?: string}>}
   */
  async function send(dataBytes, meta, cb = {}, opts = {}) {
    const { onStatus = () => {}, onStatsUpdate = () => {}, onLog = () => {} } = cb;
    const volume = opts.volume ?? 0.6;
    const transferId = Packet.randomTransferId();

    const stats = {
      packetsSent: 0, packetsAcked: 0, retransmissions: 0,
      bytesTotal: dataBytes.length, bytesAcked: 0, rounds: 0,
    };
    const pushStats = () => onStatsUpdate({ ...stats });

    async function sendAndWait(framedPacket, expectFrameLen, timeoutMs, retries, label) {
      const maxAttempts = retries + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        onStatus(`SENDING_${label}`);
        await Transmitter.sendPacket(framedPacket, volume);
        stats.packetsSent++; pushStats();
        const result = await Receiver.listenForPacket(timeoutMs, expectFrameLen, { onStatus });
        if (result.packet) return result;
        onLog(`${label}: ${result.timedOut ? 'timed out' : 'corrupted reply'} (attempt ${attempt}/${maxAttempts})`);
        stats.retransmissions++;
      }
      return null;
    }

    // ---- Handshake ----
    onLog('Sending HELLO...');
    const hello = Packet.create({ transferId, type: PacketType.HELLO, sequence: 0, total: 0 });
    const helloResult = await sendAndWait(hello, Packet.CONTROL_FRAME_LEN, waitTimeoutFor(Packet.CONTROL_FRAME_LEN), 4, 'HELLO');
    if (!helloResult || helloResult.packet.type !== PacketType.HELLO_ACK) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'No HELLO_ACK — is the other laptop in RECEIVE mode and listening?' };
    }

    onLog('Sending CAPABILITIES...');
    const capsPayload = new Uint8Array(4);
    u32(new DataView(capsPayload.buffer), 0, WBAudio.getSampleRate());
    const caps = Packet.create({ transferId, type: PacketType.CAPABILITIES, sequence: 0, total: 0, payload: capsPayload });
    const capsResult = await sendAndWait(caps, Packet.DATA_FRAME_LEN, waitTimeoutFor(Packet.DATA_FRAME_LEN), 3, 'CAPABILITIES');
    if (!capsResult || capsResult.packet.type !== PacketType.CAPABILITIES_ACK) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'No CAPABILITIES_ACK from receiver.' };
    }

    const totalPackets = Math.max(1, Math.ceil(dataBytes.length / CHUNK_SIZE));
    if (totalPackets > 65535) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'File too large for current protocol limits (max ~2MB).' };
    }

    onLog(`Sending START_TRANSFER (${dataBytes.length} bytes, ${totalPackets} packets)...`);
    const nameBytes = utf8Encode(meta.filename || (meta.isText ? 'message.txt' : 'file.bin')).slice(0, MAX_NAME_BYTES);
    const startPayload = new Uint8Array(4 + 2 + 1 + 1 + nameBytes.length);
    const startView = new DataView(startPayload.buffer);
    u32(startView, 0, dataBytes.length);
    u16(startView, 4, totalPackets);
    startPayload[6] = meta.isText ? 1 : 0;
    startPayload[7] = nameBytes.length;
    startPayload.set(nameBytes, 8);
    const startPkt = Packet.create({ transferId, type: PacketType.START_TRANSFER, sequence: 0, total: totalPackets, payload: startPayload });
    // Expect Packet.DATA_FRAME_LEN here, not CONTROL_FRAME_LEN: ACK is a
    // data-frame-sized type (see packet.js), and it's the only reply this
    // wait can legally receive.
    const startResult = await sendAndWait(startPkt, Packet.DATA_FRAME_LEN, waitTimeoutFor(Packet.DATA_FRAME_LEN), 3, 'START_TRANSFER');
    if (!startResult || startResult.packet.type !== PacketType.ACK) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'Receiver did not acknowledge START_TRANSFER.' };
    }

    // ---- Data phase ----
    let pending = new Set(Array.from({ length: totalPackets }, (_, i) => i));
    const MAX_ROUNDS = 30; // was 8 -- larger files need more retry headroom

    while (pending.size > 0 && stats.rounds < MAX_ROUNDS) {
      stats.rounds++;
      const seqList = Array.from(pending).sort((a, b) => a - b);
      onLog(`Round ${stats.rounds}: sending ${seqList.length} packet(s)...`);

      for (const seq of seqList) {
        const start = seq * CHUNK_SIZE;
        const chunk = dataBytes.subarray(start, Math.min(start + CHUNK_SIZE, dataBytes.length));
        const dataPkt = Packet.create({ transferId, type: PacketType.DATA, sequence: seq, total: totalPackets, payload: chunk });
        onStatus('SENDING_DATA');
        await Transmitter.sendPacket(dataPkt, volume);
        stats.packetsSent++;
        pushStats();
      }

      onLog('Waiting for ACK/NACK...');
      const ackResult = await Receiver.listenForPacket(
        waitTimeoutFor(Packet.DATA_FRAME_LEN),
        Packet.DATA_FRAME_LEN,
        { onStatus }
      );

      if (!ackResult.packet) {
        onLog('No response — will resend this round.');
        continue; // retry same pending set
      }

      if (ackResult.packet.type === PacketType.ACK) {
        pending.clear();
        stats.bytesAcked = dataBytes.length;
        stats.packetsAcked = totalPackets;
        pushStats();
        break;
      }

      if (ackResult.packet.type === PacketType.NACK) {
        const p = ackResult.packet.payload;
        const missingCount = p[0] || 0;
        const newPending = new Set();
        for (let i = 0; i < missingCount && i < NACK_MAX_ENTRIES; i++) {
          const seq = new DataView(p.buffer, p.byteOffset).getUint16(1 + i * 2, false);
          newPending.add(seq);
        }
        pending = newPending;
        stats.packetsAcked = totalPackets - pending.size;
        stats.bytesAcked = stats.packetsAcked * CHUNK_SIZE;
        pushStats();
        onLog(`NACK: ${pending.size} packet(s) need retransmission.`);
      }
    }

    if (pending.size > 0) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: `Gave up after ${MAX_ROUNDS} rounds; ${pending.size} packet(s) never confirmed.` };
    }

    // ---- Integrity ----
    onLog('Computing SHA-256 and sending END_TRANSFER...');
    const hashHex = await SHA256.hash(dataBytes);
    const hashBytes = new Uint8Array(hashHex.match(/.{1,2}/g).map((h) => parseInt(h, 16)));
    const endPkt = Packet.create({ transferId, type: PacketType.END_TRANSFER, sequence: 0, total: totalPackets, payload: hashBytes });
    // Expect Packet.DATA_FRAME_LEN: the reply here is ACK on hash match OR
    // NACK on mismatch, and both are now data-frame-sized (see packet.js).
    const endResult = await sendAndWait(endPkt, Packet.DATA_FRAME_LEN, waitTimeoutFor(Packet.DATA_FRAME_LEN), 3, 'END_TRANSFER');

    if (endResult && endResult.packet.type === PacketType.ACK) {
      onStatus('TRANSFER_COMPLETE');
      return { success: true, hash: hashHex };
    }
    onStatus('TRANSFER_FAILED');
    return { success: false, reason: 'Receiver could not verify file integrity (hash mismatch or no response).' };
  }

  // ============================ RECEIVE ============================

  /**
   * @param {object} cb - onStatus, onStatsUpdate, onLog, onMeta({filename, size, isText, totalPackets})
   * @param {object} opts - { volume, transferTimeoutMs }
   * @returns {Promise<{success: boolean, bytes?: Uint8Array, meta?: object, hashMatch?: boolean, reason?: string}>}
   */
  async function receive(cb = {}, opts = {}) {
    const { onStatus = () => {}, onStatsUpdate = () => {}, onLog = () => {}, onMeta = () => {} } = cb;
    const volume = opts.volume ?? 0.6;
    const overallTimeoutMs = opts.transferTimeoutMs ?? 1800000; // was 180000 (3 min) -> 30 min
    const deadline = performance.now() + overallTimeoutMs;

    const stats = { packetsReceived: 0, packetsLost: 0, packetsRecovered: 0, crcErrors: 0, retransmissions: 0 };
    const pushStats = () => onStatsUpdate({ ...stats });

    onStatus('LISTENING');
    onLog('Waiting for HELLO...');

    let helloResult;
    while (true) {
      if (performance.now() > deadline) return { success: false, reason: 'Timed out waiting for a transmission.' };
      helloResult = await Receiver.listenForPacket(waitTimeoutFor(Packet.CONTROL_FRAME_LEN), Packet.CONTROL_FRAME_LEN, { onStatus });
      if (helloResult.corrupted) { stats.crcErrors++; pushStats(); }
      if (helloResult.packet && helloResult.packet.type === PacketType.HELLO) break;
    }

    const transferId = helloResult.packet.transferId;
    onLog('HELLO received — replying HELLO_ACK.');
    await Transmitter.sendPacket(
      Packet.create({ transferId, type: PacketType.HELLO_ACK, sequence: 0, total: 0 }),
      volume
    );

    onLog('Waiting for CAPABILITIES...');
    const capsResult = await Receiver.listenForPacket(waitTimeoutFor(Packet.DATA_FRAME_LEN), Packet.DATA_FRAME_LEN, { onStatus });
    if (!capsResult.packet || capsResult.packet.type !== PacketType.CAPABILITIES) {
      return { success: false, reason: 'Did not receive CAPABILITIES after HELLO.' };
    }
    await Transmitter.sendPacket(
      Packet.create({ transferId, type: PacketType.CAPABILITIES_ACK, sequence: 0, total: 0, payload: capsResult.packet.payload }),
      volume
    );

    onLog('Waiting for START_TRANSFER...');
    const startResult = await Receiver.listenForPacket(waitTimeoutFor(Packet.DATA_FRAME_LEN), Packet.DATA_FRAME_LEN, { onStatus });
    if (!startResult.packet || startResult.packet.type !== PacketType.START_TRANSFER) {
      return { success: false, reason: 'Did not receive START_TRANSFER.' };
    }
    const sp = startResult.packet.payload;
    const spView = new DataView(sp.buffer, sp.byteOffset);
    const fileSize = spView.getUint32(0, false);
    const totalPackets = spView.getUint16(4, false);
    const isText = sp[6] === 1;
    const nameLen = sp[7];
    const filename = utf8Decode(sp.slice(8, 8 + nameLen));
    onMeta({ filename, size: fileSize, isText, totalPackets });
    onLog(`START_TRANSFER: "${filename}", ${fileSize} bytes, ${totalPackets} packets.`);

    await Transmitter.sendPacket(
      Packet.create({ transferId, type: PacketType.ACK, sequence: 0, total: totalPackets }),
      volume
    );

    // ---- Data phase ----
    const chunks = new Map(); // sequence -> Uint8Array
    const perPacketTimeout = waitTimeoutFor(Packet.DATA_FRAME_LEN);
    const MAX_ROUNDS = 30; // was 8 -- larger files need more retry headroom

    for (let round = 0; round < MAX_ROUNDS && chunks.size < totalPackets; round++) {
      const missingBefore = totalPackets - chunks.size;
      onLog(`Round ${round + 1}: expecting ${missingBefore} packet(s).`);

      let consecutiveTimeouts = 0;
      while (chunks.size < totalPackets && consecutiveTimeouts < 3) {
        const result = await Receiver.listenForPacket(perPacketTimeout, Packet.DATA_FRAME_LEN, { onStatus });
        if (result.corrupted) { stats.crcErrors++; pushStats(); continue; }
        if (result.timedOut) { consecutiveTimeouts++; continue; }
        consecutiveTimeouts = 0;
        const pkt = result.packet;
        if (pkt.type !== PacketType.DATA || pkt.transferId !== transferId) continue;
        if (!chunks.has(pkt.sequence)) {
          chunks.set(pkt.sequence, pkt.payload);
          stats.packetsReceived++;
          if (result.corrected > 0) stats.packetsRecovered++;
          pushStats();
        }
      }

      const missing = [];
      for (let i = 0; i < totalPackets; i++) if (!chunks.has(i)) missing.push(i);
      stats.packetsLost = missing.length;
      pushStats();

      if (missing.length === 0) {
        onLog('All packets received — sending ACK.');
        await Transmitter.sendPacket(Packet.create({ transferId, type: PacketType.ACK, sequence: 0, total: totalPackets }), volume);
        break;
      }

      onLog(`Requesting retransmission of ${missing.length} packet(s) via NACK.`);
      stats.retransmissions += missing.length;
      pushStats();
      const nackPayload = new Uint8Array(1 + Math.min(missing.length, NACK_MAX_ENTRIES) * 2);
      nackPayload[0] = Math.min(missing.length, NACK_MAX_ENTRIES);
      const nackView = new DataView(nackPayload.buffer);
      for (let i = 0; i < nackPayload[0]; i++) nackView.setUint16(1 + i * 2, missing[i], false);
      await Transmitter.sendPacket(Packet.create({ transferId, type: PacketType.NACK, sequence: 0, total: totalPackets, payload: nackPayload }), volume);
    }

    if (chunks.size < totalPackets) {
      return { success: false, reason: `Only received ${chunks.size}/${totalPackets} packets after max retries.` };
    }

    // ---- Reassembly ----
    onStatus('RECONSTRUCTING');
    const assembled = new Uint8Array(fileSize);
    let offset = 0;
    for (let i = 0; i < totalPackets; i++) {
      const chunk = chunks.get(i);
      assembled.set(chunk.subarray(0, Math.min(chunk.length, fileSize - offset)), offset);
      offset += chunk.length;
    }

    onLog('Waiting for END_TRANSFER (integrity hash)...');
    const endResult = await Receiver.listenForPacket(waitTimeoutFor(Packet.DATA_FRAME_LEN), Packet.DATA_FRAME_LEN, { onStatus });
    if (!endResult.packet || endResult.packet.type !== PacketType.END_TRANSFER) {
      return { success: false, reason: 'Did not receive END_TRANSFER integrity packet.' };
    }

    onStatus('VERIFYING');
    const expectedHashHex = Array.from(endResult.packet.payload).map((b) => b.toString(16).padStart(2, '0')).join('');
    const actualHashHex = await SHA256.hash(assembled);
    const match = expectedHashHex === actualHashHex;

    await Transmitter.sendPacket(
      Packet.create({ transferId, type: match ? PacketType.ACK : PacketType.NACK, sequence: 0, total: totalPackets }),
      volume
    );

    onStatus(match ? 'TRANSFER_COMPLETE' : 'TRANSFER_FAILED');
    return {
      success: match,
      bytes: assembled,
      meta: { filename, size: fileSize, isText },
      hashMatch: match,
      expectedHash: expectedHashHex,
      actualHash: actualHashHex,
    };
  }

  return { send, receive };
})();


// ---- lib/protocol-src/calibration.js ----
/**
 * calibration.js — one-button automated calibration (spec §51).
 *
 * Plays each candidate tone briefly through the speaker while recording
 * from the microphone, measuring this laptop's actual acoustic loopback
 * response (speaker + air + mic) rather than assuming flat response across
 * 18-20kHz. This runs on a single laptop with no cooperating peer required,
 * and its output (noise floor, per-tone response, suggested volume) is
 * shown in the diagnostics/research panel.
 */

const Calibration = (() => {
  async function run(onProgress = () => {}) {
    if (!WBAudio.hasMicPermission()) {
      await WBAudio.requestMicrophone();
    }
    WBAudio.startCapture();
    await new Promise((r) => setTimeout(r, 300)); // let capture warm up

    onProgress({ stage: 'NOISE_FLOOR', progress: 0.05 });
    const noiseSample = WBAudio.getRecentSamples(0.4);
    let noiseFloor = 0;
    for (const f of [...Modem.DATA_TONES, Modem.PILOT_FREQ]) {
      noiseFloor += Goertzel.power(noiseSample, f, WBAudio.getSampleRate());
    }
    noiseFloor /= (Modem.DATA_TONES.length + 1);

    const tones = [...Modem.DATA_TONES, Modem.PILOT_FREQ];
    const response = {};
    const testVolume = 0.5;

    for (let i = 0; i < tones.length; i++) {
      const freq = tones[i];
      onProgress({ stage: 'TONE_TEST', progress: 0.1 + (0.8 * i) / tones.length, freq });

      const durationSec = 0.25;
      const n = Math.round(durationSec * WBAudio.getSampleRate());
      const wave = new Float32Array(n);
      for (let s = 0; s < n; s++) {
        const t = s / WBAudio.getSampleRate();
        const ramp = Math.min(1, s / 50, (n - 1 - s) / 50);
        wave[s] = testVolume * ramp * Math.sin(2 * Math.PI * freq * t);
      }

      const playPromise = WBAudio.play(wave, testVolume);
      await new Promise((r) => setTimeout(r, 60)); // let it start reaching the mic
      const captured = WBAudio.getRecentSamples(0.3);
      await playPromise;

      const power = Goertzel.power(captured, freq, WBAudio.getSampleRate());
      response[freq] = power;
    }

    onProgress({ stage: 'ANALYZING', progress: 0.95 });

    const powers = Object.values(response);
    const maxPower = Math.max(...powers);
    const minPower = Math.min(...powers);
    const flatness = maxPower > 0 ? minPower / maxPower : 0;

    const snrEstimate = noiseFloor > 0 ? 10 * Math.log10(maxPower / noiseFloor) : 0;
    let suggestedVolume = 0.6;
    if (snrEstimate < 10) suggestedVolume = 0.85;
    else if (snrEstimate > 30) suggestedVolume = 0.4;

    const result = {
      noiseFloor,
      response,
      flatness,          // 0-1, 1 = perfectly flat response across tones
      snrEstimateDb: snrEstimate,
      suggestedVolume,
      weakTones: Object.entries(response).filter(([, p]) => p < maxPower * 0.15).map(([f]) => Number(f)),
    };

    onProgress({ stage: 'DONE', progress: 1, result });
    return result;
  }

  return { run };
})();


module.exports = { Transmitter, Receiver, FileTransfer, Calibration };
