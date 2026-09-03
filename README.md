# WAVEBYTE

**Near-Ultrasonic Acoustic Data & File Communication System**

*Digital data. Through sound.*

WaveByte lets two ordinary laptops exchange text and binary files using only their built-in speakers and microphones — no Wi-Fi, no Bluetooth, no server, no internet connection between the two machines. Data is converted to a near-ultrasonic (18–20 kHz) audio signal, played from one laptop's speaker, picked up by the other laptop's microphone, and decoded back into the original bytes.

```
DIGITAL DATA → PACKETIZATION → FEC → MODULATION → SPEAKER
                                                       ↓
                                                     AIR
                                                       ↓
ORIGINAL DATA ← FEC DECODE ← DEMODULATION ← MICROPHONE
```

## What this is (and isn't)

This is a genuinely working acoustic modem, not a simulation — every layer described below actually runs: real audio synthesis and capture via the Web Audio API, real chirp-based synchronization, real frequency-offset compensation, real Hamming(7,4) forward error correction, real CRC32 + SHA-256 integrity checking, and real selective-repeat retransmission.

It is **not** the full OFDM/adaptive-QPSK system that near-ultrasonic acoustic research literature describes (see [Research Basis](#research-basis) below). Building that would take considerably more engineering time than a modem that actually completes end-to-end file transfers today. WaveByte v1 uses **8-ary FSK** (8 tones, 3 bits/symbol) instead — simpler, slower, but robust on consumer hardware in a browser tab. The modem is isolated behind a small API (`js/modem.js`) specifically so it can be replaced with a higher-throughput scheme later without touching the protocol, packet, or UI layers.

**Expect roughly tens to low hundreds of bits per second in practice** — a short text message takes a few seconds; a small file can take minutes. The UI always displays *measured* bitrate, never a fixed claim.

## Hardware requirements

- Exactly two laptops/computers with a working built-in speaker and microphone.
- A modern desktop browser (Chrome, Edge, or Firefox recommended — see [Supported Browsers](#supported-browsers)).
- No external microphone, speaker, sound card, Raspberry Pi, Arduino, ESP32, Bluetooth device, or network connection between the two machines is used or required for the acoustic link itself.

## How it works

1. **Send:** pick a file (or type a message), set a volume, press **TRANSMIT**.
2. **Receive:** open WaveByte on the second laptop, press **LISTEN**, allow microphone access.
3. The two laptops perform a short handshake (`HELLO` → `CAPABILITIES` → `START_TRANSFER`), then the sender streams data packets. The receiver acknowledges what it got and requests retransmission of anything missing or corrupted (CRC32-checked, packet by packet).
4. Once every packet is confirmed, the sender transmits a SHA-256 hash of the whole file. The receiver recomputes the hash of what it reconstructed and only offers the **DOWNLOAD FILE** button if the hashes match exactly.

No file content is ever written to disk, uploaded, or sent anywhere except through the air between the two laptops.

## Supported browsers

Chrome, Edge, and Firefox (recent desktop versions) are recommended — all support the Web Audio API and `getUserMedia` features WaveByte relies on. Safari's audio timing behavior is less predictable for this kind of real-time synthesis/capture and hasn't been validated. Desktop/laptop is the primary target; WaveByte is not optimized for mobile browsers.

## Running locally

WaveByte is a static site with no build step and no server component.

```bash
git clone https://github.com/<your-username>/WaveByte.git
cd WaveByte
python3 -m http.server 8000
# open http://localhost:8000 in two browser windows/tabs, or on two laptops on the same LAN
```

Any static file server works — Python's, `npx serve`, VS Code's Live Server extension, etc. Opening `index.html` directly via `file://` may block microphone access in some browsers, so a local server is recommended even for local testing.

## Deploying

### GitHub Pages

1. Push this repository to GitHub.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`.
4. Save. The site will be published at `https://<your-username>.github.io/WaveByte/`.

All asset paths in this project are relative, so it works correctly from a GitHub Pages subpath.

### Hugging Face Spaces (alternative)

WaveByte has no backend, so it deploys equally well as a **Static** Space:

1. Create a new Space → SDK: **Static**.
2. Upload the contents of this repository (or push via git — Spaces are git repos).
3. The Space serves `index.html` directly; no `app.py` or build step is needed.

Either host is equivalent for this project — the only thing that must reach the internet is the initial page load. All communication after that happens acoustically between the two laptops.

## Sending text vs. files

- **Text Chat** tab: type a message, press SEND. Unicode is fully supported (UTF-8), including combining scripts and emoji.
- **Send** tab: drag a file in, or click to browse. Any file type is treated as opaque binary data — WaveByte never inspects or assumes a file format.

## Microphone permissions

The **Receive** and **Text Chat → Listen** actions request microphone access the first time they're used. WaveByte explains why before the browser prompt appears, and processes all audio locally — nothing is uploaded. If permission is denied, WaveByte shows a clear error rather than repeatedly re-prompting; you'll need to re-enable the microphone permission for the site in your browser settings and reload.

## Privacy

WaveByte is local-first by construction:

- No file or message content is ever sent to a server.
- No WebSockets, no WebRTC data channels, no Firebase, no cloud storage.
- The only network activity is loading the static site itself.
- Audio in memory (the rolling microphone capture buffer) is never persisted or transmitted anywhere except as sound played back out the speaker.

## Limitations

- **Throughput**: tens to low hundreds of bits per second, measured live and shown in the UI — not a fixed guarantee. See [Performance](#performance-expectations).
- **Range**: designed for roughly 1–5 meters in a quiet room; actual range depends heavily on laptop model, speaker/mic quality, ambient noise, and orientation.
- **File size**: the current protocol's 16-bit sequence field caps a single transfer at 65,535 packets × 32 bytes ≈ 2 MB. Large files will simply take a long time, not fail outright, up to that cap.
- **Audibility**: 18–20 kHz is *near*-ultrasonic, not universally inaudible — human hearing varies, and some people (especially younger listeners) may perceive a faint tone. WaveByte's UI warns about this and defaults to a moderate volume.
- **One transfer at a time**: the protocol is half-duplex and single-session; it doesn't multiplex multiple simultaneous transfers.
- **Browser audio processing**: some operating systems/browsers apply their own automatic gain control or noise suppression that WaveByte cannot fully disable via `getUserMedia` constraints. This can affect reception; the Calibration tool in Research mode helps characterize your specific hardware.

## Performance expectations

WaveByte measures and displays actual bitrate, packet loss, retransmissions, and (in Research mode) estimated SNR and frequency offset — it does not present a fixed theoretical number as a guarantee. Use the **Research** tab's Experiment Log to record your own measurements at different distances and export them as CSV.

## Research basis

WaveByte's operating band (18–20 kHz, using consumer laptop speakers/microphones) is grounded in published near-ultrasonic acoustic communication research. See [`docs/research.md`](docs/research.md) for a summary and clear separation between published results, this project's design targets, and whatever you actually measure on your own hardware.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "No HELLO_ACK" | The other laptop isn't in RECEIVE mode / hasn't granted mic permission yet, or the laptops are too far apart / volume too low. |
| Frequent CRC errors | Try the Calibration tool; lower ambient noise; increase transmit volume moderately; reduce distance. |
| Nothing shows in the spectrum view | Microphone permission wasn't granted, or the wrong input device is selected at the OS level. |
| Transfer very slow | Expected — see [Performance](#performance-expectations). Larger files take proportionally longer. |
| High CPU usage | Real-time Goertzel/FFT analysis in a browser tab is inherently CPU-bound; close other heavy tabs. |

See also [`docs/protocol.md`](docs/protocol.md) for the wire protocol and [`docs/architecture.md`](docs/architecture.md) for the DSP/software architecture.

## License

MIT — see [`LICENSE`](LICENSE).
