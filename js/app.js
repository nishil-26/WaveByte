/**
 * app.js — application entry point. Wires DOM events to FileTransfer,
 * Calibration, and Spectrum. No modem/protocol logic lives here.
 */

(() => {
  const { $ } = UI;

  let selectedFile = null;
  let volume = 0.6;
  let researchMode = false;
  let lastTransferRecord = null; // for experiment log
  let currentReceivedFile = null; // { bytes, meta }
  let activeTonesForSpectrum = [];
  let lastOffsetHz = 0;

  // ---------------- Mode tabs ----------------
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => UI.switchMode(btn.dataset.mode));
  });

  $('researchModeToggle').addEventListener('click', () => {
    researchMode = !researchMode;
    $('researchModeToggle').setAttribute('aria-pressed', String(researchMode));
    if (researchMode) UI.switchMode('research');
  });

  // ---------------- Dashboard init ----------------
  function initDashboard() {
    try {
      $('dashSampleRate').textContent = `${WBAudio.getSampleRate()} Hz`;
    } catch {
      $('dashSampleRate').textContent = '48000 Hz (pending)';
    }
  }
  initDashboard();

  // ---------------- Spectrum ----------------
  Spectrum.init($('spectrumCanvas'));
  // Canvas backing resolution vs CSS size
  function fitCanvas() {
    const canvas = $('spectrumCanvas');
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(600, Math.floor(rect.width));
  }
  window.addEventListener('resize', fitCanvas);
  setTimeout(fitCanvas, 50);

  // Spectrum starts once mic permission exists; started lazily on first use.
  function ensureSpectrumRunning() {
    Spectrum.start(() => activeTonesForSpectrum, () => lastOffsetHz);
  }

  // Poll shared diagnostics (updated inside receiver.js) into the dashboard.
  setInterval(() => {
    if (performance.now() - Diagnostics.lastUpdate < 4000) {
      lastOffsetHz = Diagnostics.offsetHz;
      $('dashOffset').textContent = `${Diagnostics.offsetHz.toFixed(0)} Hz`;
      $('dashConfidence').textContent = Diagnostics.confidence.toFixed(2);
    }
  }, 300);

  // ==================================================================
  // SEND — file transfer
  // ==================================================================

  const dropzone = $('dropzone');
  const fileInput = $('fileInput');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) setSelectedFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) setSelectedFile(fileInput.files[0]);
  });

  $('clearFile').addEventListener('click', () => {
    selectedFile = null;
    $('fileSummary').hidden = true;
    dropzone.hidden = false;
    $('transmitBtn').disabled = true;
  });

  function setSelectedFile(file) {
    selectedFile = file;
    $('fileName').textContent = file.name;
    $('fileMeta').textContent = `${UI.formatBytes(file.size)} · ${file.type || 'application/octet-stream'}`;
    $('fileSummary').hidden = false;
    dropzone.hidden = true;
    $('transmitBtn').disabled = false;
  }

  $('volumeSlider').addEventListener('input', (e) => {
    volume = Number(e.target.value) / 100;
    $('volumeValue').textContent = `${e.target.value}%`;
  });

  $('transmitBtn').addEventListener('click', async () => {
    if (!selectedFile) return;
    $('transmitBtn').disabled = true;
    $('sendReadout').hidden = false;
    UI.setStatus('transmitting', 'TRANSMITTING');
    ensureSpectrumRunning();

    const arrayBuffer = await selectedFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const startTime = performance.now();

    activeTonesForSpectrum = [Modem.PILOT_FREQ, ...Modem.DATA_TONES];

    const result = await FileTransfer.send(
      bytes,
      { filename: selectedFile.name, mimeType: selectedFile.type, isText: false },
      {
        onStatus: (status) => {
          UI.setLiveStatus(UI.friendlyStatus(status));
          if (status === 'TRANSFER_COMPLETE') UI.setStatus('complete', 'COMPLETE');
          if (status === 'TRANSFER_FAILED') UI.setStatus('error', 'FAILED');
        },
        onStatsUpdate: (stats) => {
          const elapsed = (performance.now() - startTime) / 1000;
          const pct = Math.round((stats.bytesAcked / stats.bytesTotal) * 100) || 0;
          $('sendProgressFill').style.width = `${pct}%`;
          $('sendProgress').textContent = `${pct}%`;
          $('sendBitrate').textContent = UI.formatBitrate(stats.bytesAcked, elapsed);
          $('sendPacketsSent').textContent = stats.packetsSent;
          $('sendPacketsAcked').textContent = stats.packetsAcked;
          $('sendRetransmissions').textContent = stats.retransmissions;
          const remaining = stats.bytesTotal - stats.bytesAcked;
          const rate = stats.bytesAcked / Math.max(elapsed, 0.001);
          $('sendEta').textContent = rate > 0 ? UI.formatDuration(remaining / rate) : '—';
        },
        onLog: (msg) => UI.log(msg),
      },
      { volume }
    );

    const elapsed = (performance.now() - startTime) / 1000;
    lastTransferRecord = {
      bytes: bytes.length,
      seconds: elapsed,
      success: result.success,
      retransmissions: Number($('sendRetransmissions').textContent) || 0,
      packetsTotal: Number($('sendPacketsAcked').textContent) || 0,
    };

    if (result.success) {
      UI.log(`Transfer complete. SHA-256: ${result.hash}`, 'ok');
    } else {
      UI.log(`Transfer failed: ${result.reason}`, 'err');
    }
    $('transmitBtn').disabled = false;
  });

  // ==================================================================
  // RECEIVE — file transfer
  // ==================================================================

  $('listenBtn').addEventListener('click', async () => {
    try {
      if (!WBAudio.hasMicPermission()) {
        UI.log('Requesting microphone permission...');
        await WBAudio.requestMicrophone();
      }
    } catch (err) {
      $('micLabel').textContent = 'Microphone permission denied.';
      UI.log(String(err.message || err), 'err');
      return;
    }

    $('micState').dataset.active = 'true';
    $('micLabel').textContent = 'Listening for an incoming transmission…';
    $('listenBtn').hidden = true;
    $('stopListenBtn').hidden = false;
    $('rxReadout').hidden = false;
    $('integrityBanner').hidden = true;
    $('downloadBtn').hidden = true;
    UI.setStatus('listening', 'LISTENING');
    ensureSpectrumRunning();
    activeTonesForSpectrum = [Modem.PILOT_FREQ, ...Modem.DATA_TONES];

    const startTime = performance.now();
    const result = await FileTransfer.receive(
      {
        onStatus: (status) => {
          UI.setLiveStatus(UI.friendlyStatus(status));
          if (status === 'TRANSFER_COMPLETE') UI.setStatus('complete', 'COMPLETE');
          if (status === 'TRANSFER_FAILED') UI.setStatus('error', 'FAILED');
        },
        onStatsUpdate: (stats) => {
          const elapsed = (performance.now() - startTime) / 1000;
          const totalPackets = Number($('rxFileMeta').dataset.totalPackets) || 1;
          const pct = Math.min(100, Math.round((stats.packetsReceived / totalPackets) * 100));
          $('rxProgressFill').style.width = `${pct}%`;
          $('rxProgress').textContent = `${pct}%`;
          $('rxBitrate').textContent = UI.formatBitrate(stats.packetsReceived * 32, elapsed);
          $('rxPacketsReceived').textContent = stats.packetsReceived;
          $('rxCrcErrors').textContent = stats.crcErrors;
          $('rxRecovered').textContent = stats.packetsRecovered;
          $('rxRetransmissions').textContent = stats.retransmissions;
        },
        onLog: (msg) => UI.log(msg),
        onMeta: (meta) => {
          $('receiveMeta').hidden = false;
          $('rxFileName').textContent = meta.isText ? '(text message)' : meta.filename;
          $('rxFileMeta').textContent = `${UI.formatBytes(meta.size)} · ${meta.totalPackets} packets`;
          $('rxFileMeta').dataset.totalPackets = meta.totalPackets;
        },
      },
      { volume }
    );

    $('listenBtn').hidden = false;
    $('stopListenBtn').hidden = true;
    $('micState').dataset.active = 'false';
    $('micLabel').textContent = 'Microphone ready';

    const elapsed = (performance.now() - startTime) / 1000;
    lastTransferRecord = {
      bytes: result.bytes ? result.bytes.length : 0,
      seconds: elapsed,
      success: result.success,
      retransmissions: Number($('rxRetransmissions').textContent) || 0,
      packetsTotal: Number($('rxPacketsReceived').textContent) || 0,
    };

    if (result.success) {
      $('integrityBanner').hidden = false;
      $('integrityBanner').className = 'integrity-banner ok';
      $('integrityBanner').textContent = `✓ FILE VERIFIED — SHA-256 MATCH (${result.actualHash.slice(0, 16)}…)`;
      currentReceivedFile = { bytes: result.bytes, meta: result.meta };
      $('downloadBtn').hidden = false;
      UI.log('Integrity verified — SHA-256 match.', 'ok');
    } else {
      $('integrityBanner').hidden = false;
      $('integrityBanner').className = 'integrity-banner fail';
      $('integrityBanner').textContent = `✗ ${result.reason || 'INTEGRITY CHECK FAILED'}`;
      UI.log(`Receive failed: ${result.reason}`, 'err');
    }
  });

  $('stopListenBtn').addEventListener('click', () => {
    WBAudio.stopCapture();
    $('listenBtn').hidden = false;
    $('stopListenBtn').hidden = true;
    UI.setStatus('ready', 'READY');
    UI.setLiveStatus('IDLE');
  });

  $('downloadBtn').addEventListener('click', () => {
    if (!currentReceivedFile) return;
    const blob = new Blob([currentReceivedFile.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = $('downloadAnchor');
    a.href = url;
    a.download = currentReceivedFile.meta.filename || 'received.bin';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // ==================================================================
  // TEXT CHAT
  // ==================================================================

  function appendChatBubble(text, sent) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${sent ? 'sent' : 'received'}`;
    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = new Date().toLocaleTimeString([], { hour12: false });
    bubble.textContent = text;
    bubble.appendChild(time);
    $('chatLog').appendChild(bubble);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  }

  $('chatSendBtn').addEventListener('click', async () => {
    const text = $('chatInput').value.trim();
    if (!text) return;
    $('chatInput').value = '';
    appendChatBubble(text, true);
    UI.setStatus('transmitting', 'TRANSMITTING');
    ensureSpectrumRunning();
    activeTonesForSpectrum = [Modem.PILOT_FREQ, ...Modem.DATA_TONES];

    const bytes = new TextEncoder().encode(text);
    const result = await FileTransfer.send(
      bytes,
      { filename: 'message.txt', isText: true },
      {
        onStatus: (s) => UI.setLiveStatus(UI.friendlyStatus(s)),
        onStatsUpdate: () => {},
        onLog: (msg) => UI.log(msg),
      },
      { volume }
    );
    UI.setStatus(result.success ? 'complete' : 'error', result.success ? 'COMPLETE' : 'FAILED');
    UI.log(result.success ? 'Message delivered.' : `Message failed: ${result.reason}`, result.success ? 'ok' : 'err');
  });

  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('chatSendBtn').click();
  });

  $('chatListenBtn').addEventListener('click', async () => {
    try {
      if (!WBAudio.hasMicPermission()) await WBAudio.requestMicrophone();
    } catch (err) {
      UI.log(String(err.message || err), 'err');
      return;
    }
    UI.setStatus('listening', 'LISTENING');
    ensureSpectrumRunning();
    activeTonesForSpectrum = [Modem.PILOT_FREQ, ...Modem.DATA_TONES];
    $('chatListenBtn').disabled = true;
    $('chatListenBtn').textContent = 'LISTENING…';

    const result = await FileTransfer.receive(
      {
        onStatus: (s) => UI.setLiveStatus(UI.friendlyStatus(s)),
        onStatsUpdate: () => {},
        onLog: (msg) => UI.log(msg),
        onMeta: () => {},
      },
      { volume, transferTimeoutMs: 60000 }
    );

    $('chatListenBtn').disabled = false;
    $('chatListenBtn').textContent = 'LISTEN FOR MESSAGE';

    if (result.success && result.meta.isText) {
      const text = new TextDecoder('utf-8').decode(result.bytes);
      appendChatBubble(text, false);
      UI.setStatus('complete', 'COMPLETE');
      UI.log('Message received.', 'ok');
    } else if (!result.success) {
      UI.setStatus('error', 'FAILED');
      UI.log(`No message received: ${result.reason}`, 'err');
    }
  });

  // ==================================================================
  // RESEARCH / CALIBRATION
  // ==================================================================

  $('calibrateBtn').addEventListener('click', async () => {
    $('calibrateBtn').disabled = true;
    $('calibrateBtn').textContent = 'CALIBRATING…';
    $('calibrationResult').hidden = false;
    $('calibrationResult').textContent = 'Running calibration sequence…';
    ensureSpectrumRunning();

    try {
      const result = await Calibration.run((progress) => {
        if (progress.freq) {
          activeTonesForSpectrum = [progress.freq];
        }
      });

      const lines = [
        `Noise floor: ${result.noiseFloor.toExponential(2)}`,
        `Estimated SNR: ${result.snrEstimateDb.toFixed(1)} dB`,
        `Tone response flatness: ${(result.flatness * 100).toFixed(0)}%`,
        `Suggested volume: ${Math.round(result.suggestedVolume * 100)}%`,
        result.weakTones.length
          ? `Weak tones (consider avoiding): ${result.weakTones.map((f) => (f / 1000).toFixed(2) + 'k').join(', ')}`
          : 'All tones responded within normal range.',
      ];
      $('calibrationResult').textContent = lines.join('\n');
      UI.log('Calibration complete.', 'ok');

      $('volumeSlider').value = Math.round(result.suggestedVolume * 100);
      volume = result.suggestedVolume;
      $('volumeValue').textContent = `${Math.round(result.suggestedVolume * 100)}%`;
    } catch (err) {
      $('calibrationResult').textContent = `Calibration failed: ${err.message || err}`;
      UI.log(`Calibration failed: ${err.message || err}`, 'err');
    }

    $('calibrateBtn').disabled = false;
    $('calibrateBtn').textContent = 'CALIBRATE CHANNEL';
  });

  // ---------------- Experiment log ----------------
  const experimentRows = [];

  $('expRecordBtn').addEventListener('click', () => {
    if (!lastTransferRecord) {
      UI.log('No completed transfer to record yet.', 'err');
      return;
    }
    const distance = Number($('expDistance').value) || 0;
    const bitrate = UI.formatBitrate(lastTransferRecord.bytes, lastTransferRecord.seconds);
    const per = lastTransferRecord.packetsTotal > 0
      ? ((lastTransferRecord.retransmissions / (lastTransferRecord.packetsTotal + lastTransferRecord.retransmissions)) * 100).toFixed(1) + '%'
      : '—';
    const row = {
      distance, bitrate, per,
      retries: lastTransferRecord.retransmissions,
      result: lastTransferRecord.success ? 'OK' : 'FAILED',
    };
    experimentRows.push(row);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.distance} m</td><td>${row.bitrate}</td><td>${row.per}</td><td>${row.retries}</td><td>${row.result}</td>`;
    $('experimentBody').appendChild(tr);
  });

  $('exportCsvBtn').addEventListener('click', () => {
    if (!experimentRows.length) {
      UI.log('No experiment rows to export.', 'err');
      return;
    }
    const header = 'distance_m,bitrate,per,retries,result\n';
    const csv = header + experimentRows.map((r) => `${r.distance},${r.bitrate},${r.per},${r.retries},${r.result}`).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = $('downloadAnchor');
    a.href = url;
    a.download = 'wavebyte-experiment-results.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  UI.log('WaveByte ready. Select SEND or RECEIVE to begin.');
})();
