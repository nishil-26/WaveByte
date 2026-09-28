'use strict';
/**
 * Pure DSP/protocol round-trip test — no real audio hardware involved.
 * Exercises modulate -> (simulated channel: noise + a frequency offset that
 * models sender/receiver clock drift) -> demodulate -> FEC decode -> packet
 * parse, and checks the reconstructed bytes are bit-exact. This is what CI
 * or `npm test` can verify without a microphone; it proves the modem/FEC/
 * packet logic is correct, not that any specific laptop's speaker and mic
 * will carry the signal well enough in practice (see `wavebyte calibrate`
 * for that).
 */
const { Modem, Packet, PacketType, FEC } = require('../lib/core.js');

Modem.configure(48000);

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1234);

function addNoise(waveform, noiseStdDev) {
  const out = new Float32Array(waveform.length);
  for (let i = 0; i < waveform.length; i++) {
    const u1 = Math.max(rand(), 1e-9), u2 = rand();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = waveform[i] + g * noiseStdDev;
  }
  return out;
}

function modulateWithOffset(bytes, shiftHz, sampleRate) {
  const bits = [];
  for (const byte of bytes) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  while (bits.length % Modem.BITS_PER_SYMBOL !== 0) bits.push(0);
  const symbols = [];
  for (let i = 0; i < bits.length; i += Modem.BITS_PER_SYMBOL) {
    let val = 0;
    for (let j = 0; j < Modem.BITS_PER_SYMBOL; j++) val = (val << 1) | bits[i + j];
    symbols.push(val);
  }
  const symLen = Modem.symbolSamples();
  const chirpLen = Modem.chirpSamples();
  const out = new Float32Array(chirpLen + symbols.length * symLen);
  out.set(genChirp(shiftHz), 0);
  for (let i = 0; i < symbols.length; i++) out.set(genSymbol(symbols[i], shiftHz), chirpLen + i * symLen);
  return out;

  function genChirp(shift) {
    const n = Modem.chirpSamples();
    const o = new Float32Array(n);
    const f0 = Modem.CHIRP_START + shift;
    const k = (Modem.CHIRP_END - Modem.CHIRP_START) / (Modem.CHIRP_MS / 1000);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      o[i] = 0.9 * Math.sin(2 * Math.PI * (f0 * t + (k * t * t) / 2));
    }
    return o;
  }
  function genSymbol(threeBits, shift) {
    const n = Modem.symbolSamples();
    const o = new Float32Array(n);
    const dataFreq = Modem.DATA_TONES[threeBits & 0x07] + shift;
    const pilotFreq = Modem.PILOT_FREQ + shift;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const ramp = Math.min(1, i / 40, (n - 1 - i) / 40);
      o[i] = 0.45 * ramp * (Math.sin(2 * Math.PI * dataFreq * t) + Math.sin(2 * Math.PI * pilotFreq * t));
    }
    return o;
  }
}

function runOnce(label, { payloadLen, noiseStdDev, shiftHz, leadSilenceSec }) {
  const payload = new Uint8Array(payloadLen);
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(rand() * 256);

  const transferId = Packet.randomTransferId();
  const pkt = Packet.create({ transferId, type: PacketType.DATA, sequence: 7, total: 100, payload });
  const encoded = FEC.encode(pkt);

  let waveform = shiftHz ? modulateWithOffset(encoded, shiftHz, 48000) : Modem.modulate(encoded);
  if (noiseStdDev) waveform = addNoise(waveform, noiseStdDev);

  const lead = new Float32Array(Math.round((leadSilenceSec || 0) * 48000));
  const full = new Float32Array(lead.length + waveform.length + 2000);
  full.set(waveform, lead.length);

  const symCount = Modem.symbolsForByteLength(encoded.length);
  const demod = Modem.demodulate(full, symCount);
  const fecRes = FEC.decode(demod.bytes);
  const parsed = Packet.parse(fecRes.bytes);

  const ok = parsed && parsed.valid && parsed.transferId === (transferId >>> 0) && parsed.sequence === 7 &&
    parsed.payload.length === payload.length && payload.every((v, i) => v === parsed.payload[i]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  return ok;
}

let allPass = true;
allPass &= runOnce('clean channel', { payloadLen: Packet.MAX_PAYLOAD, noiseStdDev: 0, shiftHz: 0, leadSilenceSec: 0.2 });
allPass &= runOnce('moderate noise', { payloadLen: Packet.MAX_PAYLOAD, noiseStdDev: 0.15, shiftHz: 0, leadSilenceSec: 0.2 });
allPass &= runOnce('heavier noise', { payloadLen: Packet.MAX_PAYLOAD, noiseStdDev: 0.30, shiftHz: 0, leadSilenceSec: 0.2 });
for (let shift = -150; shift <= 150; shift += 15) {
  allPass &= runOnce(`clock-drift offset ${shift}Hz`, { payloadLen: Packet.MAX_PAYLOAD, noiseStdDev: 0.1, shiftHz: shift, leadSilenceSec: 0.3 });
}

console.log(allPass ? '\nALL ROUND TRIPS PASSED' : '\nAT LEAST ONE ROUND TRIP FAILED');
process.exitCode = allPass ? 0 : 1;
