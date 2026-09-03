/**
 * spectrum.js — real-time spectrum display, 15kHz-24kHz, with the 18-20kHz
 * band and active tones highlighted. Reads directly from the AnalyserNode
 * set up in audio.js — this shows the actual microphone signal, not a
 * decorative animation.
 */

const Spectrum = (() => {
  let canvas, ctx2d, rafId = null;
  let onPeak = null; // optional callback(freq, magnitude) for diagnostics

  function init(canvasEl) {
    canvas = canvasEl;
    ctx2d = canvas.getContext('2d');
  }

  function freqToX(freq, minF, maxF, width) {
    return ((freq - minF) / (maxF - minF)) * width;
  }

  function draw(activeTones = [], detectedOffset = 0) {
    const analyser = WBAudio.getAnalyser();
    if (!analyser || !ctx2d) return;

    const bufferLen = analyser.frequencyBinCount;
    const data = new Uint8Array(bufferLen);
    analyser.getByteFrequencyData(data);

    const sampleRate = WBAudio.getSampleRate();
    const nyquist = sampleRate / 2;
    const minF = 15000, maxF = 24000;

    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);

    // Background band highlight for 18-20kHz
    const bandX0 = freqToX(18000, minF, maxF, w);
    const bandX1 = freqToX(20000, minF, maxF, w);
    ctx2d.fillStyle = 'rgba(79, 216, 232, 0.06)';
    ctx2d.fillRect(bandX0, 0, bandX1 - bandX0, h);
    ctx2d.strokeStyle = 'rgba(79, 216, 232, 0.25)';
    ctx2d.setLineDash([3, 3]);
    ctx2d.beginPath();
    ctx2d.moveTo(bandX0, 0); ctx2d.lineTo(bandX0, h);
    ctx2d.moveTo(bandX1, 0); ctx2d.lineTo(bandX1, h);
    ctx2d.stroke();
    ctx2d.setLineDash([]);

    // Frequency axis ticks
    ctx2d.fillStyle = '#5b6772';
    ctx2d.font = '10px "JetBrains Mono", monospace';
    for (let f = minF; f <= maxF; f += 1000) {
      const x = freqToX(f, minF, maxF, w);
      ctx2d.fillText((f / 1000).toFixed(0) + 'k', x + 2, h - 4);
    }

    // Spectrum trace
    ctx2d.beginPath();
    ctx2d.strokeStyle = '#4fd8e8';
    ctx2d.lineWidth = 1.5;
    let first = true;
    for (let i = 0; i < bufferLen; i++) {
      const freq = (i * nyquist) / bufferLen;
      if (freq < minF || freq > maxF) continue;
      const x = freqToX(freq, minF, maxF, w);
      const y = h - (data[i] / 255) * h;
      if (first) { ctx2d.moveTo(x, y); first = false; }
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();

    // Fill under trace, subtle
    ctx2d.lineTo(w, h);
    ctx2d.lineTo(0, h);
    ctx2d.closePath();
    ctx2d.fillStyle = 'rgba(79, 216, 232, 0.08)';
    ctx2d.fill();

    // Mark active carrier tones (pilot + data tones), offset-adjusted
    ctx2d.fillStyle = '#e8a94f';
    for (const freq of activeTones) {
      const x = freqToX(freq + detectedOffset, minF, maxF, w);
      ctx2d.beginPath();
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x - 4, 10);
      ctx2d.lineTo(x + 4, 10);
      ctx2d.closePath();
      ctx2d.fill();
    }
  }

  function start(getActiveTones, getOffset) {
    stop();
    const loop = () => {
      draw(getActiveTones ? getActiveTones() : [], getOffset ? getOffset() : 0);
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  return { init, start, stop, draw };
})();
