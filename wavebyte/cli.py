import argparse, os, sys, time
import numpy as np
from . import audio, probe
from .link import Sender, Receiver
from .profiles import PROFILES, get


def _prof(a):
    kw = {}
    if a.f_lo: kw["f_lo"] = a.f_lo
    if a.guard_ms: kw["guard_ms"] = a.guard_ms
    return a.profile, kw


def cmd_send(a):
    name, kw = _prof(a)
    if a.text is not None:
        data, fname, is_text = a.text.encode(), "message.txt", True
    else:
        data, fname, is_text = open(a.file, "rb").read(), os.path.basename(a.file), False
    s = Sender(name, **kw)
    per = s.seconds_per_round(len(data))
    print(f"{len(data)} bytes, profile '{name}': ~{per:.0f}s per pass, {a.rounds} pass(es)")
    wf = s.waveform(data, fname, is_text, rounds=a.rounds)
    if a.wav:
        audio.write_wav(a.wav, wf, s.p.fs); print("wrote", a.wav)
    else:
        print("Playing... keep the laptops 20-60 cm apart, volume ~70%, quiet room.")
        audio.play(wf, s.p.fs, a.device, a.volume)


def cmd_receive(a):
    name, kw = _prof(a)
    r = Receiver(name, **kw)
    os.makedirs(a.out, exist_ok=True)

    def finish():
        for d in r.done:
            if d["is_text"]:
                print("\nMESSAGE:", d["data"].decode("utf-8", "replace"))
            else:
                path = os.path.join(a.out, os.path.basename(d["name"]) or "received.bin")
                open(path, "wb").write(d["data"]); print("\nSAVED", path, len(d["data"]), "bytes")
        n = len(r.done); r.done.clear(); return n

    if a.wav:
        fs, x = audio.read_wav(a.wav)
        if fs != r.p.fs: raise SystemExit(f"WAV is {fs} Hz; profile needs {r.p.fs} Hz")
        r.decode_all(x); print(r.stats)
        if not finish(): print("nothing decoded")
        return
    print("Listening (Ctrl-C to stop)...")
    try:
        for blk in audio.stream_input(r.p.fs, a.device):
            r.feed(blk)
            pr = r.progress()
            print(f"\rframes ok={r.stats['frames_ok']} bad={r.stats['frames_bad']} fixed={r.stats['rs_corrected']} "
                  + " ".join(f"[{s:04x}:{h}/{t}]" for s, (h, t) in pr.items()) + "   ", end="", flush=True)
            if finish() and not a.keep_listening:
                return
    except KeyboardInterrupt:
        print()


def cmd_probe_tx(a):
    fs = PROFILES["standard"].fs
    print("Playing 6 s sweep 14-22 kHz (preceded by 1 s silence)...")
    audio.play(np.concatenate([np.zeros(fs), probe.make_sweep(fs), np.zeros(fs)]), fs, a.device, a.volume)


def cmd_probe_rx(a):
    fs = PROFILES["standard"].fs
    print("Recording 10 s - start probe-tx on the other laptop now...")
    x = audio.record(10, fs, a.device) if not a.wav else audio.read_wav(a.wav)[1]
    resp = probe.analyse(x, fs)
    if not resp: raise SystemExit("Sweep not detected: raise volume / move closer / check mic permission.")
    for f, s in resp:
        print(f"{f/1000:5.2f} kHz {s:6.1f} dB  " + "#" * max(0, int(s / 2)))
    lo, hi, prof = probe.recommend(resp)
    if prof: print(f"\nUsable band {lo:.0f}-{hi:.0f} Hz -> use --profile {prof} --f-lo {int(lo // 50 * 50 + 50)}")
    else: print("\nNo usable band >= 12 dB SNR above 14 kHz: this speaker/mic pair cannot carry near-ultrasound.")


def cmd_listen(a):
    """Original single-tone check: what is the strongest frequency the mic hears?"""
    fs = 48000
    x = audio.record(a.seconds, fs, a.device) * np.hanning(int(a.seconds * fs))
    F = np.abs(np.fft.rfft(x)); f = np.fft.rfftfreq(len(x), 1 / fs)
    m = (f >= 10000) & (f <= 24000)
    i = np.argmax(F[m]); print(f"Detected {f[m][i]:.1f} Hz, magnitude {F[m][i]:.4f}")


def cmd_selftest(a):
    from .selftest import run
    run()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="wavebyte", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, tx=False):
        p.add_argument("--profile", default="standard", choices=list(PROFILES))
        p.add_argument("--f-lo", type=float, help="lowest tone in Hz (use value suggested by probe-rx)")
        p.add_argument("--guard-ms", type=float, help="echo guard per symbol (raise to 15-30 in echoey rooms)")
        p.add_argument("--device", type=int, default=None)
        p.add_argument("--wav", help="write/read a WAV file instead of using the sound card")
        if tx: p.add_argument("--volume", type=float, default=0.7)

    s = sub.add_parser("send"); common(s, True); g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("file", nargs="?"); g.add_argument("--text"); s.add_argument("--rounds", type=int, default=2)
    s.set_defaults(fn=cmd_send)
    r = sub.add_parser("receive"); common(r); r.add_argument("--out", default="received")
    r.add_argument("--keep-listening", action="store_true"); r.set_defaults(fn=cmd_receive)
    t = sub.add_parser("probe-tx"); t.add_argument("--device", type=int); t.add_argument("--volume", type=float, default=0.7); t.set_defaults(fn=cmd_probe_tx)
    q = sub.add_parser("probe-rx"); q.add_argument("--device", type=int); q.add_argument("--wav"); q.set_defaults(fn=cmd_probe_rx)
    l = sub.add_parser("listen"); l.add_argument("--seconds", type=float, default=2); l.add_argument("--device", type=int); l.set_defaults(fn=cmd_listen)
    sub.add_parser("devices").set_defaults(fn=lambda a: audio.list_devices())
    sub.add_parser("selftest").set_defaults(fn=cmd_selftest)
    a = ap.parse_args(argv)
    if a.cmd == "send" and a.file is None and a.text is None: ap.error("give a file or --text")
    a.fn(a)
