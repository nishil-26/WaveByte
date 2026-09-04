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
