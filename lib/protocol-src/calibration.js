/**
 * calibration.js — one-button automated calibration (spec §51).
 *
 * Plays each candidate tone briefly through the speaker while recording
 * from the microphone, measuring this laptop's actual acoustic loopback
 * response (speaker + air + mic) rather than assuming flat response across
 * 18-20kHz. This runs on a single laptop with no cooperating peer required,
 * and its output (noise floor, per-tone response, suggested volume) is
 * shown in the diagnostics/research panel.
 */

const Calibration = (() => {
  async function run(onProgress = () => {}) {
    if (!WBAudio.hasMicPermission()) {
      await WBAudio.requestMicrophone();
    }
    WBAudio.startCapture();
    await new Promise((r) => setTimeout(r, 300)); // let capture warm up

    onProgress({ stage: 'NOISE_FLOOR', progress: 0.05 });
    const noiseSample = WBAudio.getRecentSamples(0.4);
    let noiseFloor = 0;
    for (const f of [...Modem.DATA_TONES, Modem.PILOT_FREQ]) {
      noiseFloor += Goertzel.power(noiseSample, f, WBAudio.getSampleRate());
    }
    noiseFloor /= (Modem.DATA_TONES.length + 1);

    const tones = [...Modem.DATA_TONES, Modem.PILOT_FREQ];
    const response = {};
    const testVolume = 0.5;

    for (let i = 0; i < tones.length; i++) {
      const freq = tones[i];
      onProgress({ stage: 'TONE_TEST', progress: 0.1 + (0.8 * i) / tones.length, freq });

      const durationSec = 0.25;
      const n = Math.round(durationSec * WBAudio.getSampleRate());
      const wave = new Float32Array(n);
      for (let s = 0; s < n; s++) {
        const t = s / WBAudio.getSampleRate();
        const ramp = Math.min(1, s / 50, (n - 1 - s) / 50);
        wave[s] = testVolume * ramp * Math.sin(2 * Math.PI * freq * t);
      }

      const playPromise = WBAudio.play(wave, testVolume);
      await new Promise((r) => setTimeout(r, 60)); // let it start reaching the mic
      const captured = WBAudio.getRecentSamples(0.3);
      await playPromise;

      const power = Goertzel.power(captured, freq, WBAudio.getSampleRate());
      response[freq] = power;
    }

    onProgress({ stage: 'ANALYZING', progress: 0.95 });

    const powers = Object.values(response);
    const maxPower = Math.max(...powers);
    const minPower = Math.min(...powers);
    const flatness = maxPower > 0 ? minPower / maxPower : 0;

    const snrEstimate = noiseFloor > 0 ? 10 * Math.log10(maxPower / noiseFloor) : 0;
    let suggestedVolume = 0.6;
    if (snrEstimate < 10) suggestedVolume = 0.85;
    else if (snrEstimate > 30) suggestedVolume = 0.4;

    const result = {
      noiseFloor,
      response,
      flatness,          // 0-1, 1 = perfectly flat response across tones
      snrEstimateDb: snrEstimate,
      suggestedVolume,
      weakTones: Object.entries(response).filter(([, p]) => p < maxPower * 0.15).map(([f]) => Number(f)),
    };

    onProgress({ stage: 'DONE', progress: 1, result });
    return result;
  }

  return { run };
})();
