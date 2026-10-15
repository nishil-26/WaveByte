"""Frame <-> codeword layer: header + payload + CRC-16, Reed-Solomon, whitening."""
import binascii
import struct
from . import rs
from .profiles import Profile, HEADER_BYTES

VERSION = 1
T_META, T_DATA = 0, 1


def _prbs(n: int, seed: int = 0xACE1) -> bytes:
    """Fixed pseudo-random whitening sequence (16-bit LFSR) so that long runs of
    identical payload bytes never turn into one stationary tone."""
    out, s = bytearray(), seed
    for _ in range(n):
        b = 0
        for _ in range(8):
            bit = ((s >> 0) ^ (s >> 2) ^ (s >> 3) ^ (s >> 5)) & 1
            s = (s >> 1) | (bit << 15)
            b = (b << 1) | (s & 1)
        out.append(b)
    return bytes(out)


def build_frame(p: Profile, ftype: int, session: int, seq: int, total: int, payload: bytes) -> bytes:
    if len(payload) > p.payload:
        raise ValueError("payload too large for profile")
    hdr = struct.pack(">BHHHB", (VERSION << 4) | ftype, session & 0xFFFF, seq, total, len(payload))
    body = hdr + payload.ljust(p.payload, b"\x00")
    body += struct.pack(">H", binascii.crc_hqx(body, 0xFFFF))
    cw = rs.encode(body, p.nsym)
    w = _prbs(len(cw))
    return bytes(a ^ b for a, b in zip(cw, w))


def parse_frame(p: Profile, codeword: bytes):
    """Return dict or None. `corrected` = number of Reed-Solomon byte errors fixed."""
    if len(codeword) < p.codeword_bytes:
        return None
    cw = codeword[: p.codeword_bytes]
    w = _prbs(len(cw))
    cw = bytes(a ^ b for a, b in zip(cw, w))
    try:
        body, corrected = rs.decode(cw, p.nsym)
    except rs.RSError:
        return None
    if binascii.crc_hqx(body[:-2], 0xFFFF) != struct.unpack(">H", body[-2:])[0]:
        return None
    vt, session, seq, total, plen = struct.unpack(">BHHHB", body[:HEADER_BYTES])
    if vt >> 4 != VERSION or plen > p.payload:
        return None
    return dict(type=vt & 0x0F, session=session, seq=seq, total=total,
                payload=body[HEADER_BYTES:HEADER_BYTES + plen], corrected=corrected)
