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
