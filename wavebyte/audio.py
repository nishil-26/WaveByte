"""Sound-card and WAV I/O.  `sounddevice` is imported lazily so everything else
(modem, tests, WAV workflow) works on machines with no audio stack."""
import queue
import numpy as np


def _sd():
    try:
        import sounddevice as sd
        return sd
    except Exception as e:  # PortAudio missing, etc.
        raise SystemExit(f"Audio unavailable ({e}). Install: pip install sounddevice  "
                         "(Linux also needs: sudo apt install libportaudio2)")


def list_devices():
    print(_sd().query_devices())


def play(wave, fs, device=None, volume=0.8):
    sd = _sd()
    sd.play((wave * volume).astype(np.float32), fs, device=device, blocking=True)


def record(seconds, fs, device=None):
    sd = _sd()
    x = sd.rec(int(seconds * fs), samplerate=fs, channels=1, dtype="float32", device=device)
    sd.wait()
    return x[:, 0]


def stream_input(fs, device=None, block_s=0.5):
    """Generator yielding successive blocks of microphone samples until closed."""
    sd = _sd()
    q = queue.Queue()
    with sd.InputStream(samplerate=fs, channels=1, dtype="float32", device=device,
                        blocksize=int(block_s * fs), callback=lambda d, f, t, s: q.put(d[:, 0].copy())):
        while True:
            yield q.get()


def write_wav(path, x, fs):
    from scipy.io import wavfile
    wavfile.write(path, fs, (np.clip(x, -1, 1) * 32767).astype(np.int16))


def read_wav(path):
    from scipy.io import wavfile
    fs, x = wavfile.read(path)
    if x.ndim > 1:
        x = x[:, 0]
    if x.dtype == np.int16:
        x = x.astype(np.float32) / 32768
    elif x.dtype == np.int32:
        x = x.astype(np.float32) / 2**31
    return fs, x.astype(np.float32)
