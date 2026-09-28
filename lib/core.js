'use strict';
// GENERATED FILE -- do not edit directly.
// Built by build/make-core-bundle.js from lib/core-src/*.js.
// Those source files are kept byte-identical in spirit to WaveByte's
// browser js/ files (same modem/packet/FEC/CRC logic, zero DOM dependency),
// concatenated here into one shared top-level scope (like separate <script>
// tags in the browser build) and exported for require().


// ---- lib/core-src/crc32.js ----
/**
 * crc32.js — CRC-32 (IEEE 802.3 polynomial) for packet-level error detection.
 *
 * Every WaveByte packet carries a CRC32 of its header+payload. The receiver
 * recomputes it on arrival; a mismatch means the packet is corrupted and is
 * discarded (never silently accepted — see docs/protocol.md).
 */

const CRC32 = (() => {
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    TABLE[n] = c >>> 0;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {number} unsigned 32-bit CRC
   */
  function calculate(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function verify(bytes, expected) {
    return calculate(bytes) === (expected >>> 0);
  }

  return { calculate, verify };
})();


// ---- lib/core-src/fec.js ----
/**
 * fec.js — Forward Error Correction layer.
 *
 * v1 implementation: Hamming(7,4) single-error-correcting code, applied to
 * every nibble of the packet bytes. This is intentionally the simplest FEC
 * that (a) genuinely corrects bit errors without retransmission and
 * (b) is cheap enough to run in real time in a browser tab.
 *
 * The layer is isolated behind encode()/decode() so it can be swapped for
 * Reed–Solomon or a convolutional code later without touching the modem,
 * packet, or transfer layers (see docs/architecture.md).
 */

const FEC = (() => {
  // Hamming(7,4) generator/parity-check built from the standard construction.
  // Data bits d1 d2 d3 d4 -> code bits p1 p2 d1 p3 d2 d3 d4
  function encodeNibble(nibble) {
    const d1 = (nibble >> 3) & 1;
    const d2 = (nibble >> 2) & 1;
    const d3 = (nibble >> 1) & 1;
    const d4 = nibble & 1;

    const p1 = d1 ^ d2 ^ d4;
    const p2 = d1 ^ d3 ^ d4;
    const p3 = d2 ^ d3 ^ d4;

    // 7 bits, MSB first: p1 p2 d1 p3 d2 d3 d4
    return (p1 << 6) | (p2 << 5) | (d1 << 4) | (p3 << 3) | (d2 << 2) | (d3 << 1) | d4;
  }

  function decodeNibble(code7) {
    let bits = [
      (code7 >> 6) & 1, // p1 (1)
      (code7 >> 5) & 1, // p2 (2)
      (code7 >> 4) & 1, // d1 (3)
      (code7 >> 3) & 1, // p3 (4)
      (code7 >> 2) & 1, // d2 (5)
      (code7 >> 1) & 1, // d3 (6)
      code7 & 1,        // d4 (7)
    ];

    const c1 = bits[0] ^ bits[2] ^ bits[4] ^ bits[6]; // checks positions 1,3,5,7
    const c2 = bits[1] ^ bits[2] ^ bits[5] ^ bits[6]; // checks positions 2,3,6,7
    const c3 = bits[3] ^ bits[4] ^ bits[5] ^ bits[6]; // checks positions 4,5,6,7

    const syndrome = (c3 << 2) | (c2 << 1) | c1; // 1-indexed error position, 0 = no error
    let corrected = false;
    if (syndrome !== 0 && syndrome <= 7) {
      bits[syndrome - 1] ^= 1;
      corrected = true;
    }

    const d1 = bits[2], d2 = bits[4], d3 = bits[5], d4 = bits[6];
    return { nibble: (d1 << 3) | (d2 << 2) | (d3 << 1) | d4, corrected };
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {Uint8Array} one byte per 7-bit codeword (packed as two codewords per input byte)
   */
  function encode(bytes) {
    const out = new Uint8Array(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
      const hi = (bytes[i] >> 4) & 0x0F;
      const lo = bytes[i] & 0x0F;
      out[i * 2] = encodeNibble(hi);
      out[i * 2 + 1] = encodeNibble(lo);
    }
    return out;
  }

  /**
   * @param {Uint8Array} codewords - one byte per 7-bit codeword (low 7 bits used)
   * @returns {{bytes: Uint8Array, correctedCount: number}}
   */
  function decode(codewords) {
    const byteCount = Math.floor(codewords.length / 2);
    const out = new Uint8Array(byteCount);
    let correctedCount = 0;
    for (let i = 0; i < byteCount; i++) {
      const hiRes = decodeNibble(codewords[i * 2] & 0x7F);
      const loRes = decodeNibble(codewords[i * 2 + 1] & 0x7F);
      if (hiRes.corrected) correctedCount++;
      if (loRes.corrected) correctedCount++;
      out[i] = (hiRes.nibble << 4) | loRes.nibble;
    }
    return { bytes: out, correctedCount };
  }

  return { encode, decode, encodeNibble, decodeNibble };
})();


// ---- lib/core-src/packet.js ----
/**
 * packet.js — WaveByte packet protocol.
 *
 * Wire format (all multi-byte fields big-endian):
 *
 *   MAGIC          2 bytes   0x57 0x42            ("WB")
 *   VERSION        1 byte    0x01
 *   TRANSFER_ID    4 bytes   random per transfer
 *   PACKET_TYPE    1 byte    see PacketType
 *   SEQUENCE       2 bytes   packet index within transfer
 *   TOTAL          2 byte's  total packets in transfer (0 for control packets)
 *   PAYLOAD_LEN    1 byte    0-32
 *   PAYLOAD        0-32 bytes
 *   CRC32          4 bytes   CRC32 of every preceding field
 *
 * Fixed 17-byte header + up to 32 bytes payload + 4-byte CRC = up to 53 bytes.
 * Payload is capped small deliberately: at this modem's raw symbol rate every
 * extra byte costs real transmission time, and a small packet means a single
 * corrupted packet costs little to retransmit (see docs/protocol.md).
 */

const PacketType = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  CAPABILITIES: 0x03,
  CAPABILITIES_ACK: 0x04,
  START_TRANSFER: 0x05,
  DATA: 0x06,
  ACK: 0x07,
  NACK: 0x08,
  END_TRANSFER: 0x09,
  ABORT: 0x0A,
  TEXT: 0x0B,
  CALIBRATE: 0x0C,
  CALIBRATE_ACK: 0x0D,
});

const PacketTypeName = Object.fromEntries(
  Object.entries(PacketType).map(([k, v]) => [v, k])
);

const MAGIC = [0x57, 0x42];
const VERSION = 0x01;
const HEADER_LEN = 13; // magic(2)+version(1)+transferId(4)+type(1)+seq(2)+total(2)+len(1)
// Raised from 32 -> 40 bytes: a modest bump (not doubled) deliberately --
// every extra payload byte adds airtime to *every* packet and lengthens the
// buffer detectChirp() has to scan per poll tick, so this stops well short
// of the compute/latency cliff a larger jump would cause. Still raises the
// size ceiling for the same 16-bit sequence field from ~2 MB to ~2.6 MB
// (65535 packets x 40 bytes), which covers most real-world PDFs.
const MAX_PAYLOAD = 40;

// Fixed wire lengths (before FEC). Framing every packet to one of two known
// sizes means the receiver always knows exactly how many symbols to decode
// without a variable-length side-channel — a deliberate simplification of
// the "packet length" problem at this modem's low raw bitrate. Control
// packets (no payload) cost far less airtime than data-bearing ones.
const CONTROL_FRAME_LEN = HEADER_LEN + 4;               // 17 bytes, zero payload
const DATA_FRAME_LEN = HEADER_LEN + MAX_PAYLOAD + 4;     // 49 bytes, payload zero-padded to 32

// NOTE: ACK (0x07) is deliberately a DATA-frame type (49 bytes), not a
// control-frame type, even though it carries no payload of its own. Reason:
// in every exchange where ACK can arrive, a same-length NACK (0x08, a data
// frame) is *also* a legal reply the receiver could send instead (see
// docs/protocol.md's handshake diagram). listenForPacket() is told the
// expected frame length *before* it knows which of the two is coming back,
// so both legal replies to a given wait MUST share one frame length or the
// demodulator decodes the wrong number of symbols for whichever one
// actually arrives. Only HELLO/HELLO_ACK/ABORT never have a data-frame-sized
// alternative reply, so only they stay in the cheaper control frame.
const CONTROL_TYPES = new Set([0x01, 0x02, 0x0A]); // HELLO, HELLO_ACK, ABORT

const Packet = (() => {
  function randomTransferId() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  }

  function frameLenForType(type) {
    return CONTROL_TYPES.has(type) ? CONTROL_FRAME_LEN : DATA_FRAME_LEN;
  }

  /**
   * @param {object} fields
   * @param {number} fields.transferId
   * @param {number} fields.type
   * @param {number} fields.sequence
   * @param {number} fields.total
   * @param {Uint8Array} fields.payload
   * @returns {Uint8Array} complete framed packet including CRC32, zero-padded to its fixed frame length
   */
  function create({ transferId, type, sequence, total, payload = new Uint8Array(0) }) {
    if (payload.length > MAX_PAYLOAD) {
      throw new Error(`Payload exceeds MAX_PAYLOAD (${MAX_PAYLOAD} bytes)`);
    }
    const body = new Uint8Array(HEADER_LEN + payload.length);
    const view = new DataView(body.buffer);
    body[0] = MAGIC[0];
    body[1] = MAGIC[1];
    body[2] = VERSION;
    view.setUint32(3, transferId >>> 0, false);
    body[7] = type;
    view.setUint16(8, sequence & 0xFFFF, false);
    view.setUint16(10, total & 0xFFFF, false);
    body[12] = payload.length;
    body.set(payload, HEADER_LEN);

    const crc = CRC32.calculate(body);
    const framed = new Uint8Array(body.length + 4);
    framed.set(body, 0);
    new DataView(framed.buffer).setUint32(body.length, crc, false);

    const targetLen = frameLenForType(type);
    if (framed.length >= targetLen) return framed.slice(0, targetLen);
    const padded = new Uint8Array(targetLen); // zero-padded tail, ignored by parse()
    padded.set(framed, 0);
    return padded;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {object|null} parsed packet, or null if magic/CRC/length invalid
   */
  function parse(bytes) {
    if (bytes.length < HEADER_LEN + 4) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;

    const payloadLen = bytes[12];
    const expectedLen = HEADER_LEN + payloadLen + 4;
    if (bytes.length < expectedLen) return null;

    const body = bytes.subarray(0, HEADER_LEN + payloadLen);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const crcReceived = view.getUint32(HEADER_LEN + payloadLen, false);

    if (!CRC32.verify(body, crcReceived)) {
      return { valid: false, reason: 'CRC_MISMATCH' };
    }

    return {
      valid: true,
      version: bytes[2],
      transferId: view.getUint32(3, false),
      type: bytes[7],
      typeName: PacketTypeName[bytes[7]] || 'UNKNOWN',
      sequence: view.getUint16(8, false),
      total: view.getUint16(10, false),
      payload: bytes.slice(HEADER_LEN, HEADER_LEN + payloadLen),
      length: expectedLen,
    };
  }

  return {
    create,
    parse,
    randomTransferId,
    frameLenForType,
    MAX_PAYLOAD,
    HEADER_LEN,
    CONTROL_FRAME_LEN,
    DATA_FRAME_LEN,
  };
})();


// ---- lib/core-src/goertzel.js ----
/**
 * goertzel.js — Goertzel algorithm.
 *
 * Detecting the energy at one known frequency in a block of samples without
 * computing a full FFT. This is the workhorse of the FSK demodulator: for
 * every symbol we run Goertzel once per candidate tone (8 data tones + 1
 * pilot) rather than an FFT over the whole block.
 */

const Goertzel = (() => {
  /**
   * @param {Float32Array} samples - one symbol's worth of audio samples
   * @param {number} targetFreq - Hz
   * @param {number} sampleRate - Hz
   * @returns {number} relative power at targetFreq
   */
  function power(samples, targetFreq, sampleRate) {
    const n = samples.length;
    // Deliberately NOT rounded to an integer bin index: the Goertzel
    // resonator formula works for any continuous target frequency, not just
    // FFT-aligned bins. Rounding here silently snapped every query to the
    // nearest ~(sampleRate/n)-wide bin regardless of search resolution,
    // which was traced to real inaccuracy in frequency-offset estimation.
    const k = (n * targetFreq) / sampleRate;
    const omega = (2 * Math.PI * k) / n;
    const coeff = 2 * Math.cos(omega);

    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = samples[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }

    const real = s1 - s2 * Math.cos(omega);
    const imag = s2 * Math.sin(omega);
    return real * real + imag * imag;
  }

  /**
   * Estimate the actual peak frequency near an expected frequency by
   * evaluating Goertzel power across a small local sweep. Used for carrier
   * frequency offset estimation from the preamble/pilot tone.
   *
   * @param {Float32Array} samples
   * @param {number} expectedFreq
   * @param {number} sampleRate
   * @param {number} searchWidth - Hz to search either side of expectedFreq
   * @param {number} step - Hz resolution of the search
   * @returns {{freq: number, power: number}}
   */
  function findPeak(samples, expectedFreq, sampleRate, searchWidth = 800, step = 10) {
    let bestFreq = expectedFreq;
    let bestPower = -Infinity;
    for (let f = expectedFreq - searchWidth; f <= expectedFreq + searchWidth; f += step) {
      const p = power(samples, f, sampleRate);
      if (p > bestPower) {
        bestPower = p;
        bestFreq = f;
      }
    }
    return { freq: bestFreq, power: bestPower };
  }

  return { power, findPeak };
})();


// ---- lib/core-src/modem.js ----
/**
 * modem.js — the WaveByte physical layer.
 *
 * MODULATION: 8-ary FSK. Each symbol carries 3 bits by transmitting one of
 * 8 tones. A continuous pilot tone is transmitted alongside every data tone
 * so the receiver can measure carrier frequency offset in real time and
 * correct for it (built-in laptop DACs/ADCs and room acoustics reliably
 * shift the apparent frequency — see docs/research.md).
 *
 * This is intentionally simpler than the OFDM/QPSK architecture this
 * project ultimately targets (see docs/architecture.md "Modulation
 * Roadmap"). It is the version that actually works end-to-end today.
 *
 * SYNCHRONIZATION: a linear chirp (18.0kHz -> 19.8kHz over 120ms) is
 * unmistakable in a cross-correlation against ordinary room noise or
 * speech, so the receiver uses it to find the start of a transmission
 * without any manual alignment.
 */

const Modem = (() => {
  const PILOT_FREQ = 18000;         // Hz, continuous reference tone
  // Widened from 150Hz to 200Hz spacing (18400/18550/.../19450 -> this),
  // and pushed the top tone down 100Hz from where the chirp ends, so
  // adjacent tones are easier to tell apart under real-world frequency
  // drift/noise, and the sync chirp's own end frequency never coincides
  // with a data tone. This trades a little bit of symbol duration (see
  // SYMBOL_MS below) for meaningfully more margin per symbol -- see
  // docs/architecture.md "Reliability tuning" for the reasoning.
  const DATA_TONES = [18400, 18600, 18800, 19000, 19200, 19400, 19600, 19800]; // 8-FSK, 3 bits/symbol
  const BITS_PER_SYMBOL = 3;
  const SYMBOL_MS = 30;              // was 25ms; longer dwell time = better Goertzel frequency resolution and noise averaging, without inflating per-packet airtime too far
  const CHIRP_MS = 120;
  const CHIRP_START = 18000;
  const CHIRP_END = 19900;           // was 19800; kept 100Hz above the new top data tone (19800) so the chirp's sweep never overlaps a data frequency
  const GUARD_TONE_SEARCH = 90;      // Hz search radius per data tone during demod (post offset-correction) -- safely under half the new 200Hz tone spacing

  let sampleRate = 48000;

  function configure(rate) {
    sampleRate = rate;
  }

  function symbolSamples() {
    return Math.round((SYMBOL_MS / 1000) * sampleRate);
  }

  function chirpSamples() {
    return Math.round((CHIRP_MS / 1000) * sampleRate);
  }

  // ---------- Generation ----------

  function generateChirp(shiftHz = 0) {
    const n = chirpSamples();
    const out = new Float32Array(n);
    const f0 = CHIRP_START + shiftHz;
    const k = (CHIRP_END - CHIRP_START) / (CHIRP_MS / 1000); // Hz per second sweep rate
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      // instantaneous phase of a linear chirp: 2*pi*(f0*t + k*t^2/2)
      const phase = 2 * Math.PI * (f0 * t + (k * t * t) / 2);
      out[i] = 0.9 * Math.sin(phase);
    }
    return out;
  }

  function generateSymbol(threeBits) {
    const n = symbolSamples();
    const out = new Float32Array(n);
    const dataFreq = DATA_TONES[threeBits & 0x07];
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      // Raised-cosine amplitude ramp at symbol edges to reduce spectral splatter (click reduction)
      const ramp = Math.min(1, i / 40, (n - 1 - i) / 40);
      const s = Math.sin(2 * Math.PI * dataFreq * t) + Math.sin(2 * Math.PI * PILOT_FREQ * t);
      out[i] = 0.45 * ramp * s;
    }
    return out;
  }

  /**
   * @param {Uint8Array} bytes - already FEC-encoded (each element is a 7-bit-or-less codeword byte,
   *   OR raw bytes if fecApplied=false — modem only cares about the bit stream it is given)
   * @returns {Float32Array} full audio waveform: chirp + sync word + data symbols
   */
  function modulate(bytes) {
    // Build bit stream, pad to multiple of BITS_PER_SYMBOL
    const bits = [];
    for (const byte of bytes) {
      for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
    }
    while (bits.length % BITS_PER_SYMBOL !== 0) bits.push(0);

    const symbols = [];
    for (let i = 0; i < bits.length; i += BITS_PER_SYMBOL) {
      let val = 0;
      for (let j = 0; j < BITS_PER_SYMBOL; j++) val = (val << 1) | bits[i + j];
      symbols.push(val);
    }

    const chirp = generateChirp();
    const symLen = symbolSamples();
    const totalLen = chirp.length + symbols.length * symLen;
    const out = new Float32Array(totalLen);
    out.set(chirp, 0);
    for (let i = 0; i < symbols.length; i++) {
      out.set(generateSymbol(symbols[i]), chirp.length + i * symLen);
    }
    return out;
  }

  // ---------- Reception ----------

  /**
   * Cross-correlate a rolling window against a reference chirp to find the
   * transmission start. Returns the sample index of the chirp's end
   * (i.e. where the first data symbol begins), or -1 if not found.
   *
   * @param {Float32Array} buffer - captured audio (should be at least chirp length + a margin)
   * @param {number} threshold - normalized correlation threshold (0-1)
   */
  function detectChirp(buffer, threshold = 0.3) { // was 0.35; a lower lock threshold catches more real chirps at the cost of a few more false locks, which is a cheap trade because a false lock just fails CRC and gets retried -- it never corrupts data
    const ref = generateChirp();
    const refEnergy = ref.reduce((s, v) => s + v * v, 0);
    if (buffer.length < ref.length) return -1;

    let bestScore = -Infinity;
    let bestIndex = -1;
    // Was 8: simulation against synthetic frequency-shifted chirps (the
    // realistic clock-drift case between two independent laptops) found
    // narrow "dead zones" -- specific offsets where an 8-sample grid could
    // step clean over the chirp's correlation peak and score as low as 0.20
    // even on a perfectly clean signal, i.e. a silent, unrecoverable failure
    // to lock, independent of any real acoustic noise. A linear chirp's
    // matched-filter peak shifts in time roughly linearly with frequency
    // offset (peak-shift-seconds =~ offsetHz / chirp-sweep-rate-Hz-per-sec),
    // and that peak is sharp -- a coarse grid can miss it outright rather
    // than merely landing a bit off it. Halving the step to 4 keeps the
    // worst case across a +-150Hz offset sweep at ~0.62, comfortably above
    // this function's lock threshold, for about 2x the per-call cost.
    const step = 4;
    for (let start = 0; start <= buffer.length - ref.length; start += step) {
      let dot = 0, energy = 0;
      for (let i = 0; i < ref.length; i += 4) { // subsample correlation for speed
        const s = buffer[start + i];
        dot += s * ref[i];
        energy += s * s;
      }
      if (energy <= 0) continue;
      const score = dot / Math.sqrt(energy * (refEnergy / 4) + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = start;
      }
    }

    if (bestScore < threshold) return -1;
    return bestIndex + ref.length; // sample index where data begins
  }

  /**
   * Estimate carrier frequency offset from the pilot tone in a data symbol.
   * Only safe to use with a NARROW search width, since a wide one risks
   * locking onto that same symbol's data tone instead of the pilot (there is
   * no guarantee the two are far apart once shifted). Intended as a fine
   * refinement around an already-known coarse offset (see estimateOffsetFromChirp),
   * not as the sole/primary estimate.
   * @returns {number} offset in Hz (receiver_measured - expected). Negative = shifted down.
   */
  function estimateOffset(symbolSamplesArr, searchWidth = 120) {
    const { freq } = Goertzel.findPeak(symbolSamplesArr, PILOT_FREQ, sampleRate, searchWidth, 5);
    return freq - PILOT_FREQ;
  }

  /**
   * Robust coarse frequency offset estimate using the chirp preamble itself,
   * which (unlike a data symbol) never has a competing tone nearby to confuse
   * a narrow-band search. Cross-correlates the captured chirp region against
   * several frequency-shifted reference chirps and returns the best-matching
   * shift. This is the primary offset estimate used by demodulate().
   *
   * @param {Float32Array} chirpRegionSamples - exactly one chirp's worth of samples,
   *   captured at the position detectChirp() identified as the transmission start
   * @param {number} searchWidth - Hz to search either side of zero shift
   * @param {number} step - Hz resolution of the search
   * @returns {number} estimated offset in Hz
   */
  function estimateOffsetFromChirp(chirpRegionSamples, searchWidth = 800, step = 20) {
    let bestShift = 0;
    let bestScore = -Infinity;
    for (let shift = -searchWidth; shift <= searchWidth; shift += step) {
      const ref = generateChirp(shift);
      const n = Math.min(ref.length, chirpRegionSamples.length);
      let dot = 0, energy = 0;
      for (let i = 0; i < n; i += 2) { // subsample for speed
        dot += chirpRegionSamples[i] * ref[i];
        energy += ref[i] * ref[i];
      }
      const score = energy > 0 ? dot / Math.sqrt(energy) : 0;
      if (score > bestScore) {
        bestScore = score;
        bestShift = shift;
      }
    }
    return bestShift;
  }

  /**
   * Demodulate one symbol's worth of samples into 3 bits, given a frequency offset.
   * @returns {{value: number, confidence: number}}
   */
  function demodulateSymbol(samples, offsetHz) {
    let bestIdx = 0, bestPower = -Infinity, secondBest = -Infinity;
    for (let i = 0; i < DATA_TONES.length; i++) {
      const f = DATA_TONES[i] + offsetHz;
      const p = Goertzel.power(samples, f, sampleRate);
      if (p > bestPower) {
        secondBest = bestPower;
        bestPower = p;
        bestIdx = i;
      } else if (p > secondBest) {
        secondBest = p;
      }
    }
    const confidence = secondBest > 0 ? bestPower / secondBest : 1;
    return { value: bestIdx, confidence };
  }

  /**
   * Time+frequency synchronization.
   *
   * IMPORTANT SCOPE NOTE: an earlier version of this function attempted a
   * fully general large-offset estimator (searching hundreds of Hz blind)
   * using both phase-coherent chirp correlation and non-coherent frame-based
   * frequency tracking. Both were tested against synthetic large offsets
   * (300-800Hz) and neither was reliable: phase-coherent correlation
   * decorrheres over the chirp's 120ms duration under any but a very close
   * frequency guess, and frame-based tracking was prone to confusing the
   * chirp's sweep with the discrete data tones sitting in the same band.
   * Solving that properly is a real DSP research problem, not a small fix.
   *
   * What IS implemented and verified by automated round-trip testing (see
   * the test transcripts referenced in docs/architecture.md) is reliable
   * offset compensation across 0 to ±150Hz — comfortably covering the
   * dominant real-world case of two stationary laptops with independent
   * audio clock crystals. Accuracy degrades beyond roughly ±180-200Hz
   * (the pilot search window starts approaching the nearest data tone,
   * 400Hz away), and the spec's own illustrative "sent 18000, received
   * 17500" (-500Hz) example is beyond what this implementation reliably
   * compensates. Timing comes from nominal chirp correlation; offset comes
   * from a pilot-tone search in the first data symbol, deliberately kept
   * narrow enough to avoid locking onto that same symbol's own data tone.
   *
   * @param {Float32Array} buffer
   * @param {number} threshold - passed through to detectChirp()
   * @returns {{dataStart: number, offsetHz: number}|null}
   */
  function synchronize(buffer, threshold = 0.3) { // matches detectChirp's new default
    const idx = detectChirp(buffer, threshold);
    if (idx < 0) return null;

    const symLen = symbolSamples();
    const firstSymbol = buffer.subarray(idx, idx + symLen);
    if (firstSymbol.length < symLen) return null;

    const offsetHz = estimateOffset(firstSymbol, 280);
    return { dataStart: idx, offsetHz };
  }

  /**
   * Demodulate symbols directly given an already-known start position and
   * frequency offset (i.e. after synchronize()). No internal sync/offset work.
   * @param {Float32Array} dataSamples - samples starting exactly at the first data symbol
   * @param {number} offsetHz
   * @param {number} symCount
   */
  function demodulateData(dataSamples, offsetHz, symCount) {
    const symLen = symbolSamples();
    const available = Math.floor(dataSamples.length / symLen);
    const count = Math.min(symCount, available);
    const bits = [];
    let confidenceSum = 0;
    for (let i = 0; i < count; i++) {
      const start = i * symLen;
      const { value, confidence } = demodulateSymbol(dataSamples.subarray(start, start + symLen), offsetHz);
      confidenceSum += confidence;
      for (let b = BITS_PER_SYMBOL - 1; b >= 0; b--) bits.push((value >> b) & 1);
    }
    const byteCount = Math.floor(bits.length / 8);
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
      bytes[i] = v;
    }
    return { bytes, avgConfidence: count > 0 ? confidenceSum / count : 0 };
  }

  /**
   * Full demodulation of a captured buffer. The buffer should start at or
   * slightly before the actual chirp position (a margin of a few hundred
   * samples is fine and expected) — internally this runs synchronize() to
   * find the true start/offset rather than assuming the caller's index was
   * exact, since a frequency-shifted chirp can throw off naive alignment.
   *
   * @param {Float32Array} buffer
   * @param {number} expectedSymbolCount - how many symbols to decode (from packet framing knowledge)
   * @returns {{bytes: Uint8Array, offsetHz: number, avgConfidence: number}}
   */
  function demodulate(buffer, expectedSymbolCount) {
    const sync = synchronize(buffer);
    if (!sync) return { bytes: new Uint8Array(0), offsetHz: 0, avgConfidence: 0 };

    const dataSamples = buffer.subarray(sync.dataStart);
    const { bytes, avgConfidence } = demodulateData(dataSamples, sync.offsetHz, expectedSymbolCount);
    return { bytes, offsetHz: sync.offsetHz, avgConfidence };
  }

  /** How many symbols will a given codeword byte-length take, incl. chirp — used for timing/ETA. */
  function symbolsForByteLength(byteLen) {
    return Math.ceil((byteLen * 8) / BITS_PER_SYMBOL);
  }

  function durationForByteLength(byteLen) {
    const symbols = symbolsForByteLength(byteLen);
    return CHIRP_MS / 1000 + symbols * (SYMBOL_MS / 1000);
  }

  return {
    configure,
    modulate,
    detectChirp,
    demodulate,
    demodulateSymbol,
    estimateOffset,
    estimateOffsetFromChirp,
    synchronize,
    demodulateData,
    symbolSamples,
    chirpSamples,
    symbolsForByteLength,
    durationForByteLength,
    PILOT_FREQ,
    DATA_TONES,
    BITS_PER_SYMBOL,
    SYMBOL_MS,
    CHIRP_MS,
    CHIRP_START,
    CHIRP_END,
  };
})();


// ---- lib/core-src/sha256.js ----
/**
 * sha256.js — end-to-end file integrity, on top of per-packet CRC32.
 * Uses the browser-native SubtleCrypto implementation (no custom crypto).
 */

const SHA256 = (() => {
  async function hash(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(digest));
  }

  function toHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  return { hash };
})();


module.exports = { CRC32, FEC, Packet, PacketType, Goertzel, Modem, SHA256 };
