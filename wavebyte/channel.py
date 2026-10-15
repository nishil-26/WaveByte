"""Acoustic channel simulator (speaker -> room -> microphone).

Models the impairments that actually break near-ultrasonic links:
  * frequency roll-off of laptop speakers/mics above ~16 kHz (+ ripple)
  * speaker non-linearity (tanh drive / clipping)
  * multipath echoes
  * sample-clock mismatch between the two machines
  * broadband noise and a narrow-band in-band interferer
  * unknown start time, 16-bit quantisation
"""
from dataclasses import dataclass, field
import numpy as np
from scipy import signal


@dataclass
class Channel:
    snr_db: float = 20.0          # broadband (0-24 kHz) signal RMS / noise RMS at the mic
    rolloff_db: float = 12.0      # extra loss at 20 kHz vs 16 kHz (speaker + mic combined)
    ripple_db: float = 3.0        # +-ripple across the band
    echoes: tuple = ((3.0, 0.35), (9.0, 0.15))   # (delay ms, linear gain)
    clock_ppm: float = 80.0       # receiver clock error
    drive: float = 0.0            # speaker non-linearity (0 = linear)
    interferer_hz: float = None   # continuous tone inside the band
    interferer_db: float = -6.0   # interferer RMS relative to signal RMS
    lead_s: float = 0.7
    trail_s: float = 0.7
    seed: int = 0

    def apply(self, tx: np.ndarray, fs: int) -> np.ndarray:
        rng = np.random.default_rng(self.seed)
        x = np.concatenate([np.zeros(int(self.lead_s * fs)), tx.astype(np.float64),
                            np.zeros(int(self.trail_s * fs))])
        active_rms = np.sqrt(np.mean(tx.astype(np.float64) ** 2) + 1e-18)
        if self.drive > 0:
            x = np.tanh(self.drive * x) / np.tanh(self.drive)
        # frequency response
        n = len(x)
        X = np.fft.rfft(x)
        f = np.fft.rfftfreq(n, 1 / fs)
        db = -self.rolloff_db * np.clip((f - 16000.0) / 4000.0, 0, None) ** 2
        db += self.ripple_db * np.sin(2 * np.pi * f / 650.0 + rng.uniform(0, 6.28))
        x = np.fft.irfft(X * 10 ** (db / 20), n)
        # echoes
        y = x.copy()
        for ms, g in self.echoes:
            d = int(ms * fs / 1000)
            y[d:] += g * x[:-d]
        x = y
        # clock mismatch (changes duration and every frequency by ppm)
        if self.clock_ppm:
            x = signal.resample(x, int(round(len(x) * (1 + self.clock_ppm * 1e-6))))
        sig_rms = np.sqrt(np.mean(x[np.abs(x) > 1e-4 * np.max(np.abs(x))] ** 2) + 1e-18)
        noise = rng.normal(0, sig_rms / 10 ** (self.snr_db / 20), len(x))
        x = x + noise
        if self.interferer_hz:
            t = np.arange(len(x)) / fs
            x += sig_rms * 10 ** (self.interferer_db / 20) * np.sqrt(2) * np.sin(2 * np.pi * self.interferer_hz * t)
        peak = np.max(np.abs(x))
        if peak > 0.98:
            x = x * (0.98 / peak)
        return (np.round(x * 32767) / 32767).astype(np.float32)   # 16-bit ADC
