"""Reed-Solomon forward error correction over GF(2^8), pure Python.

Systematic RS(n, n-nsym) with n <= 255.  Corrects up to nsym//2 corrupted
bytes anywhere in the codeword.  Written without third-party dependencies so
the whole project runs from a plain `pip install numpy scipy sounddevice`.
"""
_EXP = [0] * 512
_LOG = [0] * 256


def _init_tables():
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D  # primitive polynomial x^8+x^4+x^3+x^2+1
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_init_tables()


class RSError(Exception):
    """Raised when a codeword has more errors than the code can correct."""


def _mul(a, b):
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _div(a, b):
    if b == 0:
        raise ZeroDivisionError
    return 0 if a == 0 else _EXP[(_LOG[a] - _LOG[b]) % 255]


def _generator(nsym):
    g = [1]
    for j in range(nsym):
        nxt = [0] * (len(g) + 1)
        for i, c in enumerate(g):
            nxt[i] ^= c
            nxt[i + 1] ^= _mul(c, _EXP[j])
        g = nxt
    return g  # highest-degree coefficient first, monic


def encode(msg: bytes, nsym: int) -> bytes:
    if len(msg) + nsym > 255:
        raise ValueError("codeword longer than 255 bytes")
    gen = _generator(nsym)
    rem = list(msg) + [0] * nsym
    for i in range(len(msg)):
        c = rem[i]
        if c:
            for j in range(1, len(gen)):
                rem[i + j] ^= _mul(gen[j], c)
    return bytes(msg) + bytes(rem[len(msg):])


def _syndromes(r, nsym):
    out = []
    for j in range(nsym):
        s = 0
        a = _EXP[j]
        for byte in r:
            s = _mul(s, a) ^ byte
        out.append(s)
    return out


def _berlekamp_massey(S):
    C, B = [1], [1]
    L, m, b = 0, 1, 1
    for n in range(len(S)):
        d = S[n]
        for i in range(1, L + 1):
            if i < len(C):
                d ^= _mul(C[i], S[n - i])
        if d == 0:
            m += 1
            continue
        T = C[:]
        coef = _div(d, b)
        if len(C) < len(B) + m:
            C = C + [0] * (len(B) + m - len(C))
        for i, Bi in enumerate(B):
            C[i + m] ^= _mul(coef, Bi)
        if 2 * L <= n:
            L = n + 1 - L
            B, b, m = T, d, 1
        else:
            m += 1
    return C, L


def _solve_gf(A, y):
    """Gauss-Jordan elimination over GF(256).  A is n x n, y length n."""
    n = len(y)
    M = [row[:] + [y[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = next((r for r in range(col, n) if M[r][col]), None)
        if piv is None:
            raise RSError("singular system")
        M[col], M[piv] = M[piv], M[col]
        inv = _div(1, M[col][col])
        M[col] = [_mul(v, inv) for v in M[col]]
        for r in range(n):
            if r != col and M[r][col]:
                f = M[r][col]
                M[r] = [v ^ _mul(f, M[col][k]) for k, v in enumerate(M[r])]
    return [M[i][n] for i in range(n)]


def decode(received: bytes, nsym: int):
    """Return (message_bytes, corrected_byte_count). Raises RSError if uncorrectable."""
    r = list(received)
    n = len(r)
    S = _syndromes(r, nsym)
    if not any(S):
        return bytes(r[: n - nsym]), 0
    C, L = _berlekamp_massey(S)
    if L == 0 or L > nsym // 2:
        raise RSError("too many errors")
    degs = []
    for deg in range(n):  # error at byte index n-1-deg has locator X = alpha^deg
        xinv = _EXP[(255 - deg) % 255]
        acc, p = 0, 1
        for c in C[: L + 1]:
            acc ^= _mul(c, p)
            p = _mul(p, xinv)
        if acc == 0:
            degs.append(deg)
    if len(degs) != L:
        raise RSError("locator roots do not match degree")
    X = [_EXP[d] for d in degs]
    A = [[_EXP[(d * j) % 255] for d in degs] for j in range(L)]
    vals = _solve_gf(A, S[:L])
    for d, v in zip(degs, vals):
        r[n - 1 - d] ^= v
    if any(_syndromes(r, nsym)):
        raise RSError("residual syndrome")
    return bytes(r[: n - nsym]), L
