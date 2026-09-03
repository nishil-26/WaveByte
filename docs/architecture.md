# WaveByte Architecture

## Layer overview

```
UI (ui.js, app.js)
  └─ Application/orchestration (file-transfer.js, calibration.js)
       └─ Protocol / packet layer (packet.js)
            └─ Error protection (fec.js, crc32.js, sha256.js)
                 └─ Modulation layer (modem.js, goertzel.js)
                      └─ Hardware interface (audio.js)
```

Each layer only talks to the one directly below it. `app.js` never touches raw audio samples; `modem.js` never knows what a "file" is. This is what makes the modulation swap described below possible without a rewrite.

## File map

```
WaveByte/
├── index.html            page structure
├── css/style.css         visual design
├── js/
│   ├── crc32.js          CRC-32 (IEEE 802.3) for per-packet integrity
│   ├── sha256.js         SubtleCrypto wrapper for end-to-end file integrity
│   ├── fec.js            Hamming(7,4) forward error correction
│   ├── packet.js         packet framing, parsing, fixed frame lengths
│   ├── goertzel.js       single-frequency tone-energy detection
│   ├── modem.js          8-FSK modulation/demodulation, chirp sync, offset compensation
│   ├── audio.js          AudioContext, microphone capture ring buffer, playback
│   ├── spectrum.js       real-time spectrum canvas rendering
│   ├── transmitter.js    packet → waveform → speaker
│   ├── receiver.js       chirp detection + packet listening primitive
│   ├── file-transfer.js  the SEND/RECEIVE protocol state machines
│   ├── calibration.js    local speaker/mic loopback measurement
│   ├── ui.js             DOM helper utilities (no protocol logic)
│   └── app.js            wires DOM events to the above
├── assets/favicon.svg
└── docs/
    ├── architecture.md   (this file)
    ├── protocol.md        wire protocol
    └── research.md        research basis and references
```

No bundler or build step is used; scripts are loaded in dependency order directly in `index.html`.

## Modulation: what's implemented and why

WaveByte's ultimate target (per the original project brief) is an OFDM-based, adaptively-modulated (BPSK/QPSK/16-QAM) physical layer with per-subcarrier channel equalization — the kind of system described in the research literature for near-ultrasonic links between consumer devices (see `research.md`).

**v1 implements 8-ary FSK instead.** Concretely:

- 8 fixed tones spaced across roughly 18.4–19.45 kHz, one active per symbol → 3 bits/symbol.
- A continuous pilot tone at 18.0 kHz transmitted alongside every data tone, used purely for carrier frequency offset measurement.
- A linear chirp preamble (18.0→19.8 kHz over 120 ms) for synchronization via cross-correlation.
- Reception via the Goertzel algorithm (one targeted DFT bin per candidate tone) rather than a full FFT per symbol, which is cheap enough to run in real time in a browser tab on ordinary hardware.

This is a legitimate, well-established acoustic modem technique (closely related to DTMF and audio-FSK modems), and — importantly — it's the version that actually completes real transfers end-to-end today, rather than a partially-implemented OFDM stack that doesn't decode anything yet.

### Why not OFDM/QPSK for v1

Real OFDM in this environment requires: a full FFT/IFFT pipeline per symbol, per-subcarrier pilot-based channel estimation, phase-tracking equalization, cyclic-prefix design tuned to the room's multipath, and adaptive modulation switching — each a substantial DSP subsystem in its own right, and each sensitive to the very consumer-hardware quirks (uneven speaker/mic frequency response, OS-level audio processing) this project explicitly has to work around. That's a multi-month undertaking done properly, not something to fake with a UI that *looks* like it's doing OFDM while not actually decoding anything (the original brief explicitly rules this out).

### Migration path

Because `modem.js` exposes only `modulate(bytes) → Float32Array` and `demodulate(buffer) → {bytes, offsetHz, avgConfidence}`, a future OFDM/QPSK implementation is a drop-in replacement: the packet layer, FEC, ARQ, and UI do not need to change. `estimateOffset()` and the chirp-based `detectChirp()` synchronization primitive are also directly reusable by an OFDM demodulator, since synchronization and offset estimation are orthogonal to the choice of subcarrier modulation.

## Frequency offset compensation

Consumer laptop DACs/ADCs and room acoustics can shift the apparent frequency of a transmitted tone (the original design brief notes an observed ~500 Hz shift as a representative example). WaveByte's receiver never assumes the received frequency equals the transmitted frequency:

1. The chirp preamble establishes coarse timing via cross-correlation.
2. `Modem.estimateOffset()` runs a Goertzel-based search around the known pilot frequency in the first data symbol to find where it actually landed.
3. Every subsequent symbol's tone search is centered on `expected_frequency + offset` rather than the nominal frequency.

**Tested and verified range: 0 to ±150 Hz**, confirmed via automated round-trip tests injecting synthetic frequency shifts at that magnitude with zero bit errors. This comfortably covers the dominant real-world case — two stationary laptops with independent, slightly-mismatched audio clock crystals. Accuracy degrades above roughly ±180-200 Hz, because the pilot search window (needed to be wide enough to catch real offsets) starts approaching the nearest data tone, 400 Hz away. Two earlier, more ambitious designs were tried and rejected during development specifically because they failed under larger synthetic offsets:

- **Phase-coherent chirp correlation** (matching a frequency-shifted reference chirp against the captured chirp via dot product) fails because the chirp's own 120ms duration means even a moderate offset accumulates tens of cycles of phase drift, destroying the correlation regardless of which shifted template is tried.
- **Non-coherent frame-based frequency tracking** (following the dominant frequency across short time frames and matching it against the chirp's known linear sweep) is theoretically more robust to phase issues but proved prone to confusing the chirp's sweep with the discrete data tones sitting in the same frequency band during testing.

Solving general large-offset (many-hundred-Hz) compensation robustly is a legitimate DSP research problem — the two published papers in `research.md` each dedicate substantial methodology to exactly this — not something to paper over with an unverified claim. The current implementation is honest about testing 0-150Hz specifically rather than asserting it "handles frequency offset" as an unqualified claim.

## Channel calibration

`calibration.js` runs a single automated operation (per the "one button" requirement): it plays each candidate tone briefly through the speaker while simultaneously recording from the microphone, on the same laptop. This measures that laptop's actual acoustic loopback response — its speaker's and microphone's real frequency response plus whatever ambient noise is present — rather than assuming flat, ideal hardware. It reports a noise floor, an SNR estimate, which tones (if any) are unusually weak, and a suggested transmit volume. This runs standalone, without requiring a cooperating peer, which is why it's useful even before you've found a second laptop to test with.

## State machine

The receive path is implemented as an explicit sequence of awaited states rather than a formal FSM object, but it follows the state progression described in the original design brief:

```
IDLE → LISTENING → (chirp detected) → SYNCHRONIZING → RECEIVING
     → PACKET_VALIDATION → (ACK/NACK loop) → RECONSTRUCTING
     → VERIFYING (SHA-256) → COMPLETE  |  TRANSFER_FAILED
```

Every terminal failure path (`TRANSFER_FAILED`, mic permission denied, no HELLO_ACK, hash mismatch, etc.) surfaces a specific, human-readable reason string to the UI rather than failing silently — see the `reason` field returned by `FileTransfer.send()`/`receive()`.

## Performance and memory

- Files are chunked into 32-byte payloads and streamed packet-by-packet; the full file is held in memory as a single `Uint8Array` (both for sending, read via the File API, and for receiving, reassembled incrementally), which is appropriate at the protocol's current ~2 MB practical ceiling but would need streaming-to-disk (e.g. the File System Access API) to scale further.
- Audio waveforms are generated per-packet via `AudioBuffer`/`AudioBufferSourceNode` rather than one node per tone, avoiding the "thousands of oscillator nodes" anti-pattern for larger transfers.
- The microphone capture path uses a `ScriptProcessorNode` into a fixed-size ring buffer (6 seconds) rather than accumulating an ever-growing capture history. `ScriptProcessorNode` is deprecated in favor of `AudioWorklet`, but was chosen here because it requires no separate worklet module file to host and load correctly from a GitHub Pages subpath — a worklet-based version is a reasonable future improvement.
