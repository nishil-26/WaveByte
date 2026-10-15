"""Modem profiles.  A profile fixes every physical-layer parameter so that
sender and receiver only need to agree on one name (or the same numbers)."""
import math
from dataclasses import dataclass, replace

HEADER_BYTES = 8   # type/ver(1) session(2) seq(2) total(2) payload_len(1)
CRC_BYTES = 2


@dataclass(frozen=True)
class Profile:
    name: str
    bits: int            # bits per FSK symbol -> M = 2**bits tones
    symbol_ms: float     # useful (integration) time of one symbol
    spacing_hz: float    # distance between adjacent tones (multiple of 1/symbol)
    f_lo: float          # lowest data tone
    nsym: int            # Reed-Solomon parity bytes per frame
    payload: int = 32    # data bytes per frame
    guard_ms: float = 5.0   # echo guard at the start of every symbol slot
    ramp_ms: float = 2.0    # raised-cosine edge to suppress clicks / splatter
    chirp_ms: float = 120.0
    gap_ms: float = 20.0
    tail_ms: float = 40.0
    fs: int = 48000
    amplitude: float = 0.5

    # ---- derived quantities -------------------------------------------------
    @property
    def M(self): return 1 << self.bits
    @property
    def tones(self): return [self.f_lo + i * self.spacing_hz for i in range(self.M)]
    @property
    def f_hi(self): return self.f_lo + (self.M - 1) * self.spacing_hz
    @property
    def chirp_lo(self): return self.f_lo - 250.0
    @property
    def chirp_hi(self): return min(self.f_hi + 250.0, 0.46 * self.fs)
    @property
    def sym_n(self): return int(round(self.symbol_ms * self.fs / 1000))
    @property
    def guard_n(self): return int(round(self.guard_ms * self.fs / 1000))
    @property
    def slot_n(self): return self.sym_n + self.guard_n
    @property
    def chirp_n(self): return int(round(self.chirp_ms * self.fs / 1000))
    @property
    def gap_n(self): return int(round(self.gap_ms * self.fs / 1000))
    @property
    def msg_bytes(self): return HEADER_BYTES + self.payload + CRC_BYTES
    @property
    def codeword_bytes(self): return self.msg_bytes + self.nsym
    @property
    def n_symbols(self): return math.ceil(self.codeword_bytes * 8 / self.bits)
    @property
    def frame_n(self):
        return self.chirp_n + self.gap_n + self.n_symbols * self.slot_n + int(self.tail_ms * self.fs / 1000)
    @property
    def frame_seconds(self): return self.frame_n / self.fs
    @property
    def net_bytes_per_s(self): return self.payload / self.frame_seconds
    @property
    def max_correctable_bytes(self): return self.nsym // 2

    def check(self):
        bin_hz = 1000.0 / self.symbol_ms
        ratio = self.spacing_hz / bin_hz
        if abs(ratio - round(ratio)) > 1e-6 or ratio < 1:
            raise ValueError(f"tone spacing {self.spacing_hz} Hz must be a whole multiple of 1/symbol = {bin_hz:.2f} Hz")
        if self.chirp_hi > self.fs / 2 - 500:
            raise ValueError("band too close to Nyquist; lower f_lo or use a higher sample rate")
        if self.codeword_bytes > 255:
            raise ValueError("codeword > 255 bytes")
        return self

    def with_(self, **kw):
        return replace(self, **kw).check()


PROFILES = {
    # 8 widely spaced tones, long symbols: the "will it work at all?" setting
    "robust":   Profile("robust",   bits=3, symbol_ms=40.0, spacing_hz=125.0, f_lo=17500.0, nsym=24).check(),
    # 16 tones, 30 ms: default
    "standard": Profile("standard", bits=4, symbol_ms=30.0, spacing_hz=100.0, f_lo=17800.0, nsym=16).check(),
    # 32 tones across ~3 kHz, 20 ms symbols: only for good hardware / short range
    "fast":     Profile("fast",     bits=5, symbol_ms=20.0, spacing_hz=100.0, f_lo=16800.0, nsym=16).check(),
}


def get(name_or_profile, **overrides):
    p = PROFILES[name_or_profile] if isinstance(name_or_profile, str) else name_or_profile
    return p.with_(**overrides) if overrides else p
