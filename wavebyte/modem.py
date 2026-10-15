"""Physical layer: M-ary FSK with chirp preamble, echo guard and matched-filter sync.

Transmit  : [linear chirp][gap][symbol slots ...][tail]
            one slot = guard + symbol; the slot carries ONE of M tones (log2 M bits)
Receive   : band-pass -> chirp matched filter (FFT correlation) -> fine timing search ->
            per-symbol tone energies by projection on the M tone frequencies -> argmax.

No coherent phase tracking is used, so the link tolerates different sound cards,
different clocks and phase-inverting hardware without any pairing step.
"""
import numpy as np
from scipy import signal
from .profiles import Profile


def _bits_to_symbols(data: bytes, bits: int, n_symbols: int) -> np.ndarray:
    b = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
    need = n_symbols * bits
    b = np.concatenate([b, np.zeros(max(0, need - len(b)), dtype=np.uint8)])[:need]
    b = b.reshape(n_symbols, bits)
    return (b * (1 << np.arange(bits - 1, -1, -1))).sum(axis=1)


def _symbols_to_bytes(sym: np.ndarray, bits: int, n_bytes: int) -> bytes:
    b = ((sym[:, None] >> np.arange(bits - 1, -1, -1)) & 1).astype(np.uint8).reshape(-1)
    b = b[: (len(b) // 8) * 8]
    return np.packbits(b).tobytes()[:n_bytes]


class Modem:
    def __init__(self, profile: Profile):
        self.p = profile
        p = profile
        n = np.arange(p.sym_n)
        # projection matrix: one complex exponential per tone over the integration window
        self._W = np.exp(-2j * np.pi * np.outer(n, p.tones) / p.fs).astype(np.complex64)  # (N, M)
        self._chirp = self._make_chirp()
        nyq = p.fs / 2
        lo = max(5000.0, p.chirp_lo - 1500.0) / nyq
        hi = min(p.chirp_hi + 1500.0, nyq * 0.98) / nyq
        self._sos = signal.butter(6, [lo, hi], btype="band", output="sos")
        self._ref = signal.sosfiltfilt(self._sos, self._chirp).astype(np.float32)
        self._ref_energy = float(np.sum(self._ref ** 2))

    # ------------------------------------------------------------------ TX --
    def _make_chirp(self):
        p = self.p
        t = np.arange(p.chirp_n) / p.fs
        k = (p.chirp_hi - p.chirp_lo) / (p.chirp_n / p.fs)
        ph = 2 * np.pi * (p.chirp_lo * t + 0.5 * k * t * t)
        return (signal.windows.tukey(p.chirp_n, 0.25) * np.sin(ph)).astype(np.float32)

    def modulate(self, codeword: bytes) -> np.ndarray:
        p = self.p
        syms = _bits_to_symbols(codeword, p.bits, p.n_symbols)
        t = np.arange(p.slot_n) / p.fs
        ramp_n = int(p.ramp_ms * p.fs / 1000)
        env = np.ones(p.slot_n)
        r = 0.5 - 0.5 * np.cos(np.pi * np.arange(ramp_n) / ramp_n)
        env[:ramp_n] = r
        env[-ramp_n:] = r[::-1]
        tones = np.array(p.tones)
        out = np.zeros(p.frame_n, dtype=np.float32)
        out[: p.chirp_n] = p.amplitude * self._chirp
        pos = p.chirp_n + p.gap_n
        for s in syms:
            # phase referenced to slot start -> every slot is an independent burst
            out[pos: pos + p.slot_n] = p.amplitude * env * np.sin(2 * np.pi * tones[s] * t)
            pos += p.slot_n
        return out

    # ------------------------------------------------------------------ RX --
    def correlate(self, x: np.ndarray) -> np.ndarray:
        """Normalised |cross-correlation| of the band-passed signal with the chirp.
        Output index i = candidate chirp start sample.  Values are in [0, 1]."""
        y = signal.sosfiltfilt(self._sos, x.astype(np.float64)).astype(np.float32)
        n = len(self._ref)
        if len(y) < n:
            return np.zeros(0, dtype=np.float32), y
        c = signal.fftconvolve(y, self._ref[::-1], mode="valid")
        cs = np.concatenate([[0.0], np.cumsum(y.astype(np.float64) ** 2)])
        local = cs[n:] - cs[:-n]
        norm = np.abs(c) / np.sqrt(local * self._ref_energy + 1e-12)
        return norm.astype(np.float32), y

    def find_chirps(self, norm: np.ndarray, threshold: float = 0.30):
        if len(norm) == 0:
            return []
        peaks, props = signal.find_peaks(norm, height=threshold, distance=int(0.04 * self.p.fs))
        return [(int(i), float(norm[i])) for i in peaks]

    def _tone_energy(self, y: np.ndarray, start: int, count: int) -> np.ndarray:
        """(count, M) matrix of tone energies for `count` consecutive symbol slots."""
        p = self.p
        idx = start + np.arange(count)[:, None] * p.slot_n + p.guard_n + np.arange(p.sym_n)[None, :]
        seg = y[idx]                       # (count, N)
        z = seg @ self._W                  # (count, M) complex
        return (z.real ** 2 + z.imag ** 2)

    def demod_frame(self, y: np.ndarray, chirp_start: int):
        """Decode one frame given the (filtered) buffer and a chirp start estimate.
        Returns (codeword_bytes, quality) or None.  Tries a few timing offsets and
        keeps the one with the cleanest symbol decisions."""
        p = self.p
        base = chirp_start + p.chirp_n + p.gap_n
        best = None
        probe = min(24, p.n_symbols)
        for d in range(-60, 61, 6):
            s0 = base + d
            if s0 < 0 or s0 + p.n_symbols * p.slot_n > len(y):
                continue
            e = self._tone_energy(y, s0, probe)
            q = float(np.sum(e.max(axis=1)) / (np.sum(e) + 1e-20))
            if best is None or q > best[0]:
                best = (q, d)
        if best is None:
            return None
        s0 = base + best[1]
        E = self._tone_energy(y, s0, p.n_symbols)
        # Per-tone background normalisation: a tone that is loud in *every* slot
        # (continuous interferer, coil whine, ultrasonic beacon) has a high median
        # and is divided out; a genuine data tone is loud in only ~1/M of the slots.
        base = np.median(E, axis=0) + 1e-9 * (E.mean() + 1e-20)
        E = E / base
        sym = E.argmax(axis=1)
        top = np.sort(E, axis=1)
        conf = float(np.mean(top[:, -1] / (top[:, -2] + 1e-20)))
        return _symbols_to_bytes(sym, p.bits, p.codeword_bytes), conf
