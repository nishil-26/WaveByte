# Research Basis

WaveByte's operating band and general approach are grounded in published work on near-ultrasonic acoustic communication between consumer devices, rather than invented from scratch. This page separates three things that should never be conflated:

1. **What published research achieved**, under its own test conditions.
2. **What WaveByte targets**, as an engineering goal.
3. **What WaveByte actually measures** on your specific hardware (see the Research tab's Experiment Log).

## Relevant published work

**Tabak, Lin, and Singer, "High Data Rate Near-Ultrasonic Communication with Consumer Devices"** (arXiv:2103.11261; also published at an IEEE conference — see arxiv.org/abs/2103.11261). This work targets a different application: transferring short PINs to establish a connection between consumer laptops using their built-in microphones and speakers, proposed as a faster alternative to Bluetooth/Wi-Fi pairing for that specific task. Notably, the paper reports that the frequency response of built-in laptop speakers and microphones in the near-ultrasonic range is typically non-flat, which disperses symbol waveforms and causes inter-symbol interference — this is precisely why WaveByte treats channel calibration and frequency-offset compensation as first-class concerns rather than assuming ideal hardware.

**Getreuer, Gnegy, et al., "Ultrasonic Communication Using Consumer Hardware"** — part of the system behind Google's Nearby platform for establishing device co-presence. This protocol operates in the 18.5–20 kHz band using ordinary smartphone speakers and microphones, achieves a raw data rate of about 94.5 bits per second using direct-sequence spread-spectrum modulation, and the authors report reliable transmission at 2 meters with reception often succeeding out to 10 meters in real indoor environments. This result is a closer match to WaveByte's actual regime — a raw bitrate in the tens to low hundreds of bps at short range — than higher-throughput OFDM results achieved under more controlled/specialized conditions.

For context, other work in this space (e.g. dedicated ultrasonic transducer systems rather than laptop built-in hardware) has achieved substantially higher rates using OFDM with QAM — one such study reports uplink rates in the tens of kb/s using 16-QAM-OFDM, extending range with QPSK-OFDM at a lower rate. Those results use purpose-built ultrasonic transducers at higher carrier frequencies, not the built-in speakers/microphones of ordinary laptops, so they are not directly comparable to what WaveByte or the two papers above are attempting.

## What WaveByte targets

- **Band:** 18–20 kHz, matching both papers above.
- **Hardware:** unmodified laptop built-in speakers and microphones only.
- **Realistic raw bitrate target:** tens to low hundreds of bps, closer to the Nearby-platform result than to specialized-transducer OFDM results, given WaveByte's current 8-FSK modulation (see [`architecture.md`](architecture.md) for why OFDM/QPSK is a future migration rather than the current implementation).
- **Range target:** 1–5 meters in a typical room, informally consistent with the "reliable at 2m" figure above, though not independently validated against that paper's methodology.

## What WaveByte actually measures

WaveByte does not claim to reproduce either paper's results. The **Research** tab's live diagnostics (measured bitrate, packet error rate, estimated SNR, frequency offset) and Experiment Log (record bitrate/PER/retries at a chosen distance, exportable as CSV) exist specifically so that any performance claim about *your* setup is something you measured, not something assumed from the literature.

## A note on "inaudible"

The Nearby-platform paper describes its 18.5–20 kHz band as inaudible to most humans. WaveByte deliberately uses the more conservative phrasing "near-ultrasonic" and "designed to minimize audibility" throughout its UI and documentation instead, because human high-frequency hearing varies by individual and tends to be more sensitive in younger listeners. WaveByte's volume control defaults to a moderate level for this reason.
