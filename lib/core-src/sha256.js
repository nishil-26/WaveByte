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
