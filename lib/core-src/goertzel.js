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
