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
