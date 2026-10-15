"""Simulation sweep: frame/file success vs. noise for each profile (NO real hardware)."""
import numpy as np
from .link import Sender, Receiver
from .channel import Channel
from .profiles import PROFILES


def run(trials=4, snrs=(10, 0, -4, -8, -12), nbytes=200):
    data = bytes(np.random.default_rng(1).integers(0, 256, nbytes, dtype=np.uint8))
    print(f"Simulated channel (roll-off 12 dB, echoes, 80 ppm clock error); {nbytes}-byte file, 1 pass, {trials} trials")
    print(f"{'profile':9s} {'net B/s':>7s} " + " ".join(f"{s:>6d}dB" for s in snrs))
    for name, p in PROFILES.items():
        row = []
        for snr in snrs:
            ok = 0
            for t in range(trials):
                s = Sender(name); wf = s.waveform(data, "f.bin", rounds=1, session=t)
                r = Receiver(name); r.decode_all(Channel(snr_db=snr, seed=t).apply(wf, p.fs))
                ok += any(d["data"] == data for d in r.done)
            row.append(f"{ok}/{trials}")
        print(f"{name:9s} {p.net_bytes_per_s:7.1f} " + " ".join(f"{x:>8s}" for x in row))
