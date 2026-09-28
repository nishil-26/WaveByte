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
