# WaveByte (Python edition)

Send text and small files between two laptops with sound only (near-ultrasonic, ~17-20 kHz).
No Wi-Fi, Bluetooth, pairing, server or return channel.

    pip install numpy scipy sounddevice        # Linux also: sudo apt install libportaudio2
    python -m wavebyte selftest                # simulated-channel sweep (no hardware)
    python -m unittest discover -s tests       # 9 tests

## Step 0 - find out whether your hardware can do it (do this first!)
    laptop B:  python -m wavebyte probe-rx     # records 10 s
    laptop A:  python -m wavebyte probe-tx     # plays a 14-22 kHz sweep
probe-rx prints the response and recommends `--profile` and `--f-lo`. If it says no usable band,
that speaker/mic pair cannot carry near-ultrasound; try closer, louder, or a lower `--f-lo`.
Also disable "audio enhancements / noise suppression / AGC" for the microphone in the OS.

## Transfer
    B: python -m wavebyte receive --profile standard
    A: python -m wavebyte send report.pdf --profile standard      (or --text "hello")
Both sides must use the same profile / --f-lo / --guard-ms. Echoey room: --guard-ms 15.
No laptops handy: `send --wav out.wav`, play it on any phone, record, `receive --wav rec.wav`
(record at 48 kHz).

## Profiles (net throughput)
robust 8 tones ~4 B/s - standard 16 tones ~7.5 B/s - fast 32 tones ~12.8 B/s.
A 100 KB file takes hours; this is for text and small files.

