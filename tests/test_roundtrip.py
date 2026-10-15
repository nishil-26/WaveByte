import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import numpy as np
from wavebyte import rs, probe
from wavebyte.link import Sender, Receiver
from wavebyte.channel import Channel
from wavebyte.profiles import PROFILES

DATA = bytes(np.random.default_rng(3).integers(0, 256, 150, dtype=np.uint8))


def roundtrip(name, ch, **kw):
    s = Sender(name, **kw); wf = s.waveform(DATA, "x.bin", rounds=1, session=5)
    r = Receiver(name, **kw); r.decode_all(ch.apply(wf, s.p.fs))
    return any(d["data"] == DATA and d["name"] == "x.bin" for d in r.done)


class T(unittest.TestCase):
    def test_rs_corrects_up_to_t(self):
        rng = np.random.default_rng(0)
        for _ in range(100):
            m = bytes(rng.integers(0, 256, 42, dtype=np.uint8)); cw = bytearray(rs.encode(m, 16))
            for p in rng.choice(len(cw), 8, replace=False): cw[p] ^= int(rng.integers(1, 256))
            self.assertEqual(rs.decode(bytes(cw), 16)[0], m)

    def test_all_profiles_noisy_channel(self):
        for n in PROFILES: self.assertTrue(roundtrip(n, Channel(snr_db=0)), n)

    def test_text_roundtrip_exact(self):
        s = Sender("standard"); r = Receiver("standard")
        r.decode_all(Channel(snr_db=5).apply(s.waveform("héllo ✓".encode(), is_text=True, rounds=1), 48000))
        self.assertEqual(r.done[0]["data"].decode(), "héllo ✓")

    def test_rolloff_nonlinear_clock(self):
        self.assertTrue(roundtrip("standard", Channel(snr_db=10, drive=3, rolloff_db=25, clock_ppm=300)))

    def test_interferer(self):
        self.assertTrue(roundtrip("robust", Channel(snr_db=10, interferer_hz=18500, interferer_db=0)))

    def test_long_guard_survives_heavy_echo(self):
        ch = Channel(snr_db=15, echoes=((6, .6), (15, .4), (25, .3)))
        self.assertTrue(roundtrip("standard", ch, guard_ms=15))

    def test_second_pass_recovers_lost_frames(self):
        s = Sender("standard"); wf = s.waveform(DATA, "x.bin", rounds=2, session=5)
        wf = wf.copy(); fl = s.p.frame_n
        wf[2 * fl: 3 * fl] = 0   # one whole frame destroyed in pass 1
        r = Receiver("standard"); r.decode_all(Channel(snr_db=10).apply(wf, 48000))
        self.assertTrue(any(d["data"] == DATA for d in r.done))

    def test_wrong_data_never_accepted(self):
        r = Receiver("standard"); rng = np.random.default_rng(9)
        r.decode_all(rng.normal(0, .1, 48000 * 15).astype(np.float32))
        self.assertEqual(r.done, []); self.assertEqual(r.stats["frames_ok"], 0)

    def test_probe_finds_band(self):
        fs = 48000; x = Channel(snr_db=20, rolloff_db=30, echoes=()).apply(probe.make_sweep(fs), fs)
        resp = probe.analyse(x, fs); self.assertIsNotNone(resp)
        lo, hi, prof = probe.recommend(resp); self.assertGreater(hi - lo, 500)


if __name__ == "__main__":
    unittest.main()
