"""Transfer layer: files and text as a *carousel* of self-contained frames.

Why a carousel instead of handshake + stop-and-wait ARQ?  Every frame carries its
own chirp preamble, session id, sequence number and Reed-Solomon parity, so the
receiver can join at any moment, accept frames in any order, and ignore frames
that fail the checks.  There is no return channel to lose, nothing to time out,
and a single bad frame costs only one more pass through the carousel.
"""
import os
import random
import struct
import zlib
from dataclasses import dataclass, field
import numpy as np
from . import codec
from .modem import Modem
from .profiles import Profile, get

FLAG_TEXT = 1
META_FMT = ">IIBB"  # size, crc32(file), flags, name_len   (10 bytes) + name


def split_payload(data: bytes, chunk: int):
    return [data[i:i + chunk] for i in range(0, len(data), chunk)] or [b""]


class Sender:
    def __init__(self, profile="standard", **overrides):
        self.p = get(profile, **overrides)
        self.modem = Modem(self.p)

    def frames(self, data: bytes, name: str = "message.txt", is_text: bool = False, session: int = None):
        p = self.p
        session = random.getrandbits(16) if session is None else session
        nm = name.encode("utf-8")[: p.payload - struct.calcsize(META_FMT)]
        meta = struct.pack(META_FMT, len(data), zlib.crc32(data) & 0xFFFFFFFF,
                           FLAG_TEXT if is_text else 0, len(nm)) + nm
        chunks = split_payload(data, p.payload)
        total = len(chunks) + 1
        if total > 0xFFFF:
            raise ValueError("file too large for 16-bit frame counter")
        out = [codec.build_frame(p, codec.T_META, session, 0, total, meta)]
        for i, c in enumerate(chunks, start=1):
            out.append(codec.build_frame(p, codec.T_DATA, session, i, total, c))
        return out

    def waveform(self, data: bytes, name="message.txt", is_text=False, rounds=2, session=None):
        frames = self.frames(data, name, is_text, session)
        one = [self.modem.modulate(f) for f in frames]
        order = []
        for r in range(rounds):
            order.extend(one)
        return np.concatenate(order)

    def seconds_per_round(self, nbytes: int):
        return (split_payload(b"x" * nbytes, self.p.payload).__len__() + 1) * self.p.frame_seconds


@dataclass
class _Session:
    total: int = 0
    meta: dict = None
    chunks: dict = field(default_factory=dict)


class Receiver:
    """Feed audio with `feed()`; completed transfers appear in `.done`."""

    def __init__(self, profile="standard", threshold=0.30, **overrides):
        self.p = get(profile, **overrides)
        self.modem = Modem(self.p)
        self.threshold = threshold
        self.buf = np.zeros(0, dtype=np.float32)
        self.base = 0           # absolute index of buf[0]
        self.skip_until = 0     # absolute index before which no new chirp is accepted
        self.tried = set()
        self.sessions = {}
        self.done = []          # list of dict(name, data, is_text, session)
        self.stats = dict(frames_ok=0, frames_bad=0, rs_corrected=0, chirps=0)
        self.log = []

    # -- audio in ---------------------------------------------------------
    def feed(self, samples: np.ndarray):
        self.buf = np.concatenate([self.buf, samples.astype(np.float32)])
        self._scan()
        # keep a bounded window: two frames + margin
        keep = 2 * self.p.frame_n + self.p.chirp_n
        if len(self.buf) > keep:
            cut = len(self.buf) - keep
            self.buf = self.buf[cut:]
            self.base += cut

    def _scan(self):
        p = self.p
        if len(self.buf) < p.frame_n:
            return
        norm, y = self.modem.correlate(self.buf)
        for idx, score in self.modem.find_chirps(norm, self.threshold):
            a = self.base + idx
            if a < self.skip_until:
                continue
            if idx + p.frame_n - p.tail_ms * p.fs // 1000 > len(self.buf):
                continue                           # frame not fully received yet
            key = a // (p.chirp_n // 2)
            if key in self.tried or (key - 1) in self.tried or (key + 1) in self.tried:
                continue
            self.stats["chirps"] += 1
            res = self.modem.demod_frame(y, idx)
            self.tried.add(key)
            if res is None:
                continue
            cw, conf = res
            fr = codec.parse_frame(p, cw)
            if fr is None:
                self.stats["frames_bad"] += 1
                continue
            self.stats["frames_ok"] += 1
            self.stats["rs_corrected"] += fr["corrected"]
            self.skip_until = a + p.chirp_n + p.gap_n + p.n_symbols * p.slot_n - p.slot_n
            self._ingest(fr)
        if len(self.tried) > 4000:
            self.tried = set(sorted(self.tried)[-1000:])

    # -- frames -> files --------------------------------------------------
    def _ingest(self, fr):
        s = self.sessions.setdefault(fr["session"], _Session())
        if fr["total"] and not s.total:
            s.total = fr["total"]
        if fr["type"] == codec.T_META and s.meta is None:
            size, crc, flags, nlen = struct.unpack(META_FMT, fr["payload"][:struct.calcsize(META_FMT)])
            off = struct.calcsize(META_FMT)
            s.meta = dict(size=size, crc=crc, flags=flags,
                          name=fr["payload"][off:off + nlen].decode("utf-8", "replace"))
        elif fr["type"] == codec.T_DATA:
            s.chunks.setdefault(fr["seq"], fr["payload"])
        self._try_finish(fr["session"], s)

    def progress(self):
        out = {}
        for sid, s in self.sessions.items():
            if s.total:
                out[sid] = (len(s.chunks) + (1 if s.meta else 0), s.total)
        return out

    def _try_finish(self, sid, s):
        if not s.total or s.meta is None or len(s.chunks) < s.total - 1:
            return
        data = b"".join(s.chunks[i] for i in range(1, s.total))[: s.meta["size"]]
        if len(data) != s.meta["size"] or (zlib.crc32(data) & 0xFFFFFFFF) != s.meta["crc"]:
            self.log.append(f"session {sid:04x}: assembled but CRC-32 mismatch, discarding")
            del self.sessions[sid]
            return
        self.done.append(dict(session=sid, name=s.meta["name"], data=data,
                              is_text=bool(s.meta["flags"] & FLAG_TEXT)))
        del self.sessions[sid]

    def decode_all(self, samples: np.ndarray, chunk_s: float = 1.0):
        """Convenience: push a whole recording through feed() in chunks, as live audio would arrive."""
        step = int(chunk_s * self.p.fs)
        for i in range(0, len(samples), step):
            self.feed(samples[i:i + step])
        return self.done
