/**
 * audio.js — the only place this project touches actual laptop hardware.
 *
 * Owns the AudioContext, microphone stream, a rolling capture buffer the
 * receiver's chirp-detector scans, and playback of modulated waveforms.
 */

const WBAudio = (() => {
  let ctx = null;
  let micStream = null;
  let micSource = null;
  let analyser = null;
  let scriptNode = null;
  let capturing = false;
  let ringBuffer = null;   // Float32Array, circular
  let ringWritePos = 0;
  let ringFilled = false;
  const RING_SECONDS = 6;  // enough to hold the longest expected single-packet transmission with margin

  function getContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      Modem.configure(ctx.sampleRate);
    }
    return ctx;
  }

  function getSampleRate() {
    return getContext().sampleRate;
  }

  async function requestMicrophone() {
    const context = getContext();
    if (context.state === 'suspended') await context.resume();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      throw new Error('MIC_PERMISSION_DENIED: ' + err.message);
    }

    micSource = context.createMediaStreamSource(micStream);
    analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.2;
    micSource.connect(analyser);

    ringBuffer = new Float32Array(Math.ceil(RING_SECONDS * context.sampleRate));
    ringWritePos = 0;
    ringFilled = false;

    // ScriptProcessorNode is deprecated but has universal support without a
    // separate worklet module file to host-load over GitHub Pages/HF Spaces;
    // buffer size chosen small enough to keep latency low.
    const bufferSize = 2048;
    scriptNode = context.createScriptProcessor(bufferSize, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      if (!capturing) return;
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        ringBuffer[ringWritePos] = input[i];
        ringWritePos = (ringWritePos + 1) % ringBuffer.length;
        if (ringWritePos === 0) ringFilled = true;
      }
    };
    micSource.connect(scriptNode);
    // CRITICAL: a ScriptProcessorNode only gets pulled through the render
    // graph (i.e. onaudioprocess only fires) if it's connected all the way
    // to context.destination. Connecting it to a node that goes nowhere
    // means the browser never processes it at all — the capture callback
    // silently never fires, regardless of real microphone input. Route
    // through a zero-gain node so there's no audible pass-through/feedback.
    const silentSink = context.createGain();
    silentSink.gain.value = 0;
    scriptNode.connect(silentSink);
    silentSink.connect(context.destination);
    return true;
  }

  function startCapture() {
    capturing = true;
  }

  function stopCapture() {
    capturing = false;
  }

  /**
   * Returns the most recent `seconds` of captured audio, in chronological order.
   */
  function getRecentSamples(seconds) {
    if (!ringBuffer) return new Float32Array(0);
    const n = Math.min(Math.ceil(seconds * getSampleRate()), ringBuffer.length);
    const out = new Float32Array(n);
    if (!ringFilled && ringWritePos < n) {
      out.set(ringBuffer.subarray(0, ringWritePos), n - ringWritePos);
      return out;
    }
    for (let i = 0; i < n; i++) {
      const idx = (ringWritePos - n + i + ringBuffer.length * 4) % ringBuffer.length;
      out[i] = ringBuffer[idx];
    }
    return out;
  }

  function getAnalyser() {
    return analyser;
  }

  /**
   * Play a Float32Array waveform through the speakers at the given volume (0-1).
   * @returns {Promise<void>} resolves when playback finishes
   */
  function play(waveform, volume = 0.6) {
    const context = getContext();
    if (context.state === 'suspended') context.resume();
    const buffer = context.createBuffer(1, waveform.length, context.sampleRate);
    buffer.copyToChannel(waveform, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    source.connect(gain);
    gain.connect(context.destination);

    return new Promise((resolve) => {
      source.onended = resolve;
      source.start();
    });
  }

  function hasMicPermission() {
    return !!micStream;
  }

  function releaseMicrophone() {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    capturing = false;
  }

  return {
    getContext,
    getSampleRate,
    requestMicrophone,
    startCapture,
    stopCapture,
    getRecentSamples,
    getAnalyser,
    play,
    hasMicPermission,
    releaseMicrophone,
  };
})();
