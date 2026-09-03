/**
 * file-transfer.js — the protocol state machine described in docs/protocol.md.
 *
 * SEND:    HELLO -> CAPABILITIES -> START_TRANSFER -> DATA... -> (NACK/ACK
 *          rounds) -> END_TRANSFER(hash) -> final ACK/NACK
 * RECEIVE: mirror of the above, passively from IDLE/LISTENING.
 *
 * Text messages and binary files both flow through this same pipeline —
 * text is just a "file" with an isText flag, which buys chat messages the
 * same CRC+FEC+ARQ+SHA-256 reliability as file transfers for free.
 */

const FileTransfer = (() => {
  const MAX_NAME_BYTES = 24;
  const CHUNK_SIZE = Packet.MAX_PAYLOAD; // 32 bytes
  const NACK_MAX_ENTRIES = 15;

  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }
  function utf8Decode(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  function u32(view, offset, value) { view.setUint32(offset, value >>> 0, false); }
  function u16(view, offset, value) { view.setUint16(offset, value & 0xFFFF, false); }

  // ============================= SEND =============================

  /**
   * @param {Uint8Array} dataBytes - raw content to send (text UTF-8 bytes or file bytes)
   * @param {object} meta - { filename, mimeType, isText }
   * @param {object} cb - callbacks: onStatus(str), onStatsUpdate(obj), onLog(str)
   * @param {object} opts - { volume }
   * @returns {Promise<{success: boolean, reason?: string}>}
   */
  async function send(dataBytes, meta, cb = {}, opts = {}) {
    const { onStatus = () => {}, onStatsUpdate = () => {}, onLog = () => {} } = cb;
    const volume = opts.volume ?? 0.6;
    const transferId = Packet.randomTransferId();

    const stats = {
      packetsSent: 0, packetsAcked: 0, retransmissions: 0,
      bytesTotal: dataBytes.length, bytesAcked: 0, rounds: 0,
    };
    const pushStats = () => onStatsUpdate({ ...stats });

    async function sendAndWait(framedPacket, expectFrameLen, timeoutMs, retries, label) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        onStatus(`SENDING_${label}`);
        await Transmitter.sendPacket(framedPacket, volume);
        stats.packetsSent++; pushStats();
        const result = await Receiver.listenForPacket(timeoutMs, expectFrameLen, { onStatus });
        if (result.packet) return result;
        onLog(`${label}: ${result.timedOut ? 'timed out' : 'corrupted reply'}, retry ${attempt + 1}/${retries}`);
        stats.retransmissions++;
      }
      return null;
    }

    // ---- Handshake ----
    onLog('Sending HELLO...');
    const hello = Packet.create({ transferId, type: PacketType.HELLO, sequence: 0, total: 0 });
    const helloResult = await sendAndWait(hello, Packet.CONTROL_FRAME_LEN, 6000, 4, 'HELLO');
    if (!helloResult || helloResult.packet.type !== PacketType.HELLO_ACK) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'No HELLO_ACK — is the other laptop in RECEIVE mode and listening?' };
    }

    onLog('Sending CAPABILITIES...');
    const capsPayload = new Uint8Array(4);
    u32(new DataView(capsPayload.buffer), 0, WBAudio.getSampleRate());
    const caps = Packet.create({ transferId, type: PacketType.CAPABILITIES, sequence: 0, total: 0, payload: capsPayload });
    const capsResult = await sendAndWait(caps, Packet.DATA_FRAME_LEN, 6000, 3, 'CAPABILITIES');
    if (!capsResult || capsResult.packet.type !== PacketType.CAPABILITIES_ACK) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'No CAPABILITIES_ACK from receiver.' };
    }

    const totalPackets = Math.max(1, Math.ceil(dataBytes.length / CHUNK_SIZE));
    if (totalPackets > 65535) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'File too large for current protocol limits (max ~2MB).' };
    }

    onLog(`Sending START_TRANSFER (${dataBytes.length} bytes, ${totalPackets} packets)...`);
    const nameBytes = utf8Encode(meta.filename || (meta.isText ? 'message.txt' : 'file.bin')).slice(0, MAX_NAME_BYTES);
    const startPayload = new Uint8Array(4 + 2 + 1 + 1 + nameBytes.length);
    const startView = new DataView(startPayload.buffer);
    u32(startView, 0, dataBytes.length);
    u16(startView, 4, totalPackets);
    startPayload[6] = meta.isText ? 1 : 0;
    startPayload[7] = nameBytes.length;
    startPayload.set(nameBytes, 8);
    const startPkt = Packet.create({ transferId, type: PacketType.START_TRANSFER, sequence: 0, total: totalPackets, payload: startPayload });
    const startResult = await sendAndWait(startPkt, Packet.CONTROL_FRAME_LEN, 6000, 3, 'START_TRANSFER');
    if (!startResult || startResult.packet.type !== PacketType.ACK) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: 'Receiver did not acknowledge START_TRANSFER.' };
    }

    // ---- Data phase ----
    let pending = new Set(Array.from({ length: totalPackets }, (_, i) => i));
    const MAX_ROUNDS = 8;

    while (pending.size > 0 && stats.rounds < MAX_ROUNDS) {
      stats.rounds++;
      const seqList = Array.from(pending).sort((a, b) => a - b);
      onLog(`Round ${stats.rounds}: sending ${seqList.length} packet(s)...`);

      for (const seq of seqList) {
        const start = seq * CHUNK_SIZE;
        const chunk = dataBytes.subarray(start, Math.min(start + CHUNK_SIZE, dataBytes.length));
        const dataPkt = Packet.create({ transferId, type: PacketType.DATA, sequence: seq, total: totalPackets, payload: chunk });
        onStatus('SENDING_DATA');
        await Transmitter.sendPacket(dataPkt, volume);
        stats.packetsSent++;
        pushStats();
      }

      onLog('Waiting for ACK/NACK...');
      const ackResult = await Receiver.listenForPacket(
        Math.max(8000, Modem.durationForByteLength(Packet.DATA_FRAME_LEN * 2) * 1000 + 3000),
        Packet.DATA_FRAME_LEN,
        { onStatus }
      );

      if (!ackResult.packet) {
        onLog('No response — will resend this round.');
        continue; // retry same pending set
      }

      if (ackResult.packet.type === PacketType.ACK) {
        pending.clear();
        stats.bytesAcked = dataBytes.length;
        stats.packetsAcked = totalPackets;
        pushStats();
        break;
      }

      if (ackResult.packet.type === PacketType.NACK) {
        const p = ackResult.packet.payload;
        const missingCount = p[0] || 0;
        const newPending = new Set();
        for (let i = 0; i < missingCount && i < NACK_MAX_ENTRIES; i++) {
          const seq = new DataView(p.buffer, p.byteOffset).getUint16(1 + i * 2, false);
          newPending.add(seq);
        }
        pending = newPending;
        stats.packetsAcked = totalPackets - pending.size;
        stats.bytesAcked = stats.packetsAcked * CHUNK_SIZE;
        pushStats();
        onLog(`NACK: ${pending.size} packet(s) need retransmission.`);
      }
    }

    if (pending.size > 0) {
      onStatus('TRANSFER_FAILED');
      return { success: false, reason: `Gave up after ${MAX_ROUNDS} rounds; ${pending.size} packet(s) never confirmed.` };
    }

    // ---- Integrity ----
    onLog('Computing SHA-256 and sending END_TRANSFER...');
    const hashHex = await SHA256.hash(dataBytes);
    const hashBytes = new Uint8Array(hashHex.match(/.{1,2}/g).map((h) => parseInt(h, 16)));
    const endPkt = Packet.create({ transferId, type: PacketType.END_TRANSFER, sequence: 0, total: totalPackets, payload: hashBytes });
    const endResult = await sendAndWait(endPkt, Packet.CONTROL_FRAME_LEN, 8000, 3, 'END_TRANSFER');

    if (endResult && endResult.packet.type === PacketType.ACK) {
      onStatus('TRANSFER_COMPLETE');
      return { success: true, hash: hashHex };
    }
    onStatus('TRANSFER_FAILED');
    return { success: false, reason: 'Receiver could not verify file integrity (hash mismatch or no response).' };
  }

  // ============================ RECEIVE ============================

  /**
   * @param {object} cb - onStatus, onStatsUpdate, onLog, onMeta({filename, size, isText, totalPackets})
   * @param {object} opts - { volume, transferTimeoutMs }
   * @returns {Promise<{success: boolean, bytes?: Uint8Array, meta?: object, hashMatch?: boolean, reason?: string}>}
   */
  async function receive(cb = {}, opts = {}) {
    const { onStatus = () => {}, onStatsUpdate = () => {}, onLog = () => {}, onMeta = () => {} } = cb;
    const volume = opts.volume ?? 0.6;
    const overallTimeoutMs = opts.transferTimeoutMs ?? 180000;
    const deadline = performance.now() + overallTimeoutMs;

    const stats = { packetsReceived: 0, packetsLost: 0, packetsRecovered: 0, crcErrors: 0, retransmissions: 0 };
    const pushStats = () => onStatsUpdate({ ...stats });

    onStatus('LISTENING');
    onLog('Waiting for HELLO...');

    let helloResult;
    while (true) {
      if (performance.now() > deadline) return { success: false, reason: 'Timed out waiting for a transmission.' };
      helloResult = await Receiver.listenForPacket(5000, Packet.CONTROL_FRAME_LEN, { onStatus });
      if (helloResult.corrupted) { stats.crcErrors++; pushStats(); }
      if (helloResult.packet && helloResult.packet.type === PacketType.HELLO) break;
    }

    const transferId = helloResult.packet.transferId;
    onLog('HELLO received — replying HELLO_ACK.');
    await Transmitter.sendPacket(
      Packet.create({ transferId, type: PacketType.HELLO_ACK, sequence: 0, total: 0 }),
      volume
    );

    onLog('Waiting for CAPABILITIES...');
    const capsResult = await Receiver.listenForPacket(6000, Packet.DATA_FRAME_LEN, { onStatus });
    if (!capsResult.packet || capsResult.packet.type !== PacketType.CAPABILITIES) {
      return { success: false, reason: 'Did not receive CAPABILITIES after HELLO.' };
    }
    await Transmitter.sendPacket(
      Packet.create({ transferId, type: PacketType.CAPABILITIES_ACK, sequence: 0, total: 0, payload: capsResult.packet.payload }),
      volume
    );

    onLog('Waiting for START_TRANSFER...');
    const startResult = await Receiver.listenForPacket(6000, Packet.DATA_FRAME_LEN, { onStatus });
    if (!startResult.packet || startResult.packet.type !== PacketType.START_TRANSFER) {
      return { success: false, reason: 'Did not receive START_TRANSFER.' };
    }
    const sp = startResult.packet.payload;
    const spView = new DataView(sp.buffer, sp.byteOffset);
    const fileSize = spView.getUint32(0, false);
    const totalPackets = spView.getUint16(4, false);
    const isText = sp[6] === 1;
    const nameLen = sp[7];
    const filename = utf8Decode(sp.slice(8, 8 + nameLen));
    onMeta({ filename, size: fileSize, isText, totalPackets });
    onLog(`START_TRANSFER: "${filename}", ${fileSize} bytes, ${totalPackets} packets.`);

    await Transmitter.sendPacket(
      Packet.create({ transferId, type: PacketType.ACK, sequence: 0, total: totalPackets }),
      volume
    );

    // ---- Data phase ----
    const chunks = new Map(); // sequence -> Uint8Array
    const perPacketTimeout = Modem.durationForByteLength(Packet.DATA_FRAME_LEN * 2) * 1000 + 2500;
    const MAX_ROUNDS = 8;

    for (let round = 0; round < MAX_ROUNDS && chunks.size < totalPackets; round++) {
      const missingBefore = totalPackets - chunks.size;
      onLog(`Round ${round + 1}: expecting ${missingBefore} packet(s).`);

      let consecutiveTimeouts = 0;
      while (chunks.size < totalPackets && consecutiveTimeouts < 3) {
        const result = await Receiver.listenForPacket(perPacketTimeout, Packet.DATA_FRAME_LEN, { onStatus });
        if (result.corrupted) { stats.crcErrors++; pushStats(); continue; }
        if (result.timedOut) { consecutiveTimeouts++; continue; }
        consecutiveTimeouts = 0;
        const pkt = result.packet;
        if (pkt.type !== PacketType.DATA || pkt.transferId !== transferId) continue;
        if (!chunks.has(pkt.sequence)) {
          chunks.set(pkt.sequence, pkt.payload);
          stats.packetsReceived++;
          if (result.corrected > 0) stats.packetsRecovered++;
          pushStats();
        }
      }

      const missing = [];
      for (let i = 0; i < totalPackets; i++) if (!chunks.has(i)) missing.push(i);
      stats.packetsLost = missing.length;
      pushStats();

      if (missing.length === 0) {
        onLog('All packets received — sending ACK.');
        await Transmitter.sendPacket(Packet.create({ transferId, type: PacketType.ACK, sequence: 0, total: totalPackets }), volume);
        break;
      }

      onLog(`Requesting retransmission of ${missing.length} packet(s) via NACK.`);
      stats.retransmissions += missing.length;
      pushStats();
      const nackPayload = new Uint8Array(1 + Math.min(missing.length, NACK_MAX_ENTRIES) * 2);
      nackPayload[0] = Math.min(missing.length, NACK_MAX_ENTRIES);
      const nackView = new DataView(nackPayload.buffer);
      for (let i = 0; i < nackPayload[0]; i++) nackView.setUint16(1 + i * 2, missing[i], false);
      await Transmitter.sendPacket(Packet.create({ transferId, type: PacketType.NACK, sequence: 0, total: totalPackets, payload: nackPayload }), volume);
    }

    if (chunks.size < totalPackets) {
      return { success: false, reason: `Only received ${chunks.size}/${totalPackets} packets after max retries.` };
    }

    // ---- Reassembly ----
    onStatus('RECONSTRUCTING');
    const assembled = new Uint8Array(fileSize);
    let offset = 0;
    for (let i = 0; i < totalPackets; i++) {
      const chunk = chunks.get(i);
      assembled.set(chunk.subarray(0, Math.min(chunk.length, fileSize - offset)), offset);
      offset += chunk.length;
    }

    onLog('Waiting for END_TRANSFER (integrity hash)...');
    const endResult = await Receiver.listenForPacket(10000, Packet.DATA_FRAME_LEN, { onStatus });
    if (!endResult.packet || endResult.packet.type !== PacketType.END_TRANSFER) {
      return { success: false, reason: 'Did not receive END_TRANSFER integrity packet.' };
    }

    onStatus('VERIFYING');
    const expectedHashHex = Array.from(endResult.packet.payload).map((b) => b.toString(16).padStart(2, '0')).join('');
    const actualHashHex = await SHA256.hash(assembled);
    const match = expectedHashHex === actualHashHex;

    await Transmitter.sendPacket(
      Packet.create({ transferId, type: match ? PacketType.ACK : PacketType.NACK, sequence: 0, total: totalPackets }),
      volume
    );

    onStatus(match ? 'TRANSFER_COMPLETE' : 'TRANSFER_FAILED');
    return {
      success: match,
      bytes: assembled,
      meta: { filename, size: fileSize, isText },
      hashMatch: match,
      expectedHash: expectedHashHex,
      actualHash: actualHashHex,
    };
  }

  return { send, receive };
})();
