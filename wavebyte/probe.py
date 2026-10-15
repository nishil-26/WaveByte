"""Channel probe: measure what your speaker->mic path really does between 14 and 22 kHz.

Run `probe-tx` on one laptop and `probe-rx` on the other (or both on one laptop to
test its own speaker+mic).  The sweep is linear, so time-in-sweep == frequency and
the received level over time is the channel's frequency response."""
import numpy as np
from scipy import signal

F0, F1, DUR = 14000.0, 22000.0, 6.0


def make_sweep(fs, amp=0.5):
    t = np.arange(int(DUR * fs)) / fs
    k = (F1 - F0) / DUR
    x = np.sin(2 * np.pi * (F0 * t + 0.5 * k * t * t)) * signal.windows.tukey(len(t), 0.05)
    return (amp * x).astype(np.float32)


def analyse(rx, fs, step=250.0, win=200.0):
    """Return list of (freq_hz, snr_db) or None if the sweep was not found."""
    ref = make_sweep(fs, 1.0)
    sos = signal.butter(6, [12000 / (fs / 2), min(23000, fs / 2 * 0.98) / (fs / 2)], "band", output="sos")
    y = signal.sosfiltfilt(sos, rx.astype(np.float64))
    c = np.abs(signal.fftconvolve(y, ref[::-1], mode="valid"))
    i = int(np.argmax(c))
    seg_e = np.sqrt(np.mean(y[i:i + len(ref)] ** 2) + 1e-18)
    pre = y[: max(0, i - int(0.2 * fs))]
    if c[i] < 8 * np.median(c) or len(pre) < int(0.3 * fs):
        pre = y[i + len(ref) + int(0.2 * fs):]           # fall back to trailing silence
    if seg_e < 1e-6 or len(pre) < int(0.3 * fs):
        return None
    out = []
    for f in np.arange(F0 + 500, F1 - 500, step):
        t_mid = (f - F0) / (F1 - F0) * DUR
        a = i + int((t_mid - 0.5 * win / (F1 - F0) * DUR) * fs)
        b = i + int((t_mid + 0.5 * win / (F1 - F0) * DUR) * fs)
        if a < 0 or b > len(y):
            continue
        bp = signal.butter(4, [(f - win) / (fs / 2), (f + win) / (fs / 2)], "band", output="sos")
        sig = np.sqrt(np.mean(signal.sosfilt(bp, y[a:b]) ** 2) + 1e-18)
        noi = np.sqrt(np.mean(signal.sosfilt(bp, pre) ** 2) + 1e-18)
        out.append((float(f), float(20 * np.log10(sig / noi))))
    return out


def recommend(resp, min_snr=12.0):
    """Widest contiguous usable band -> (f_lo, f_hi, profile_name|None)."""
    best, cur = (0, 0), None
    for f, s in resp:
        if s >= min_snr:
            cur = (cur[0] if cur else f, f)
            if cur[1] - cur[0] > best[1] - best[0]:
                best = cur
        else:
            cur = None
    width = best[1] - best[0]
    if width >= 2800: prof = "fast"
    elif width >= 1800: prof = "standard"
    elif width >= 1000: prof = "robust"
    else: prof = None
    return best[0], best[1], prof
