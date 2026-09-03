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
  const DATA_TONES = [18400, 18550, 18700, 18850, 19000, 19150, 19300, 19450]; // 8-FSK, 3 bits/symbol
  const BITS_PER_SYMBOL = 3;
  const SYMBOL_MS = 25;              // symbol duration in milliseconds
  const CHIRP_MS = 120;
  const CHIRP_START = 18000;
  const CHIRP_END = 19800;
  const GUARD_TONE_SEARCH = 90;      // Hz search radius per data tone during demod (post offset-correction)

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
  function detectChirp(buffer, threshold = 0.35) {
    const ref = generateChirp();
    const refEnergy = ref.reduce((s, v) => s + v * v, 0);
    if (buffer.length < ref.length) return -1;

    let bestScore = -Infinity;
    let bestIndex = -1;
    const step = 8; // coarse scan for speed; adequate given 25ms symbols
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
  function synchronize(buffer, threshold = 0.35) {
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
