/**
 * packet.js — WaveByte packet protocol.
 *
 * Wire format (all multi-byte fields big-endian):
 *
 *   MAGIC          2 bytes   0x57 0x42            ("WB")
 *   VERSION        1 byte    0x01
 *   TRANSFER_ID    4 bytes   random per transfer
 *   PACKET_TYPE    1 byte    see PacketType
 *   SEQUENCE       2 bytes   packet index within transfer
 *   TOTAL          2 byte's  total packets in transfer (0 for control packets)
 *   PAYLOAD_LEN    1 byte    0-32
 *   PAYLOAD        0-32 bytes
 *   CRC32          4 bytes   CRC32 of every preceding field
 *
 * Fixed 17-byte header + up to 32 bytes payload + 4-byte CRC = up to 53 bytes.
 * Payload is capped small deliberately: at this modem's raw symbol rate every
 * extra byte costs real transmission time, and a small packet means a single
 * corrupted packet costs little to retransmit (see docs/protocol.md).
 */

const PacketType = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  CAPABILITIES: 0x03,
  CAPABILITIES_ACK: 0x04,
  START_TRANSFER: 0x05,
  DATA: 0x06,
  ACK: 0x07,
  NACK: 0x08,
  END_TRANSFER: 0x09,
  ABORT: 0x0A,
  TEXT: 0x0B,
  CALIBRATE: 0x0C,
  CALIBRATE_ACK: 0x0D,
});

const PacketTypeName = Object.fromEntries(
  Object.entries(PacketType).map(([k, v]) => [v, k])
);

const MAGIC = [0x57, 0x42];
const VERSION = 0x01;
const HEADER_LEN = 13; // magic(2)+version(1)+transferId(4)+type(1)+seq(2)+total(2)+len(1)
const MAX_PAYLOAD = 32;

// Fixed wire lengths (before FEC). Framing every packet to one of two known
// sizes means the receiver always knows exactly how many symbols to decode
// without a variable-length side-channel — a deliberate simplification of
// the "packet length" problem at this modem's low raw bitrate. Control
// packets (no payload) cost far less airtime than data-bearing ones.
const CONTROL_FRAME_LEN = HEADER_LEN + 4;               // 17 bytes, zero payload
const DATA_FRAME_LEN = HEADER_LEN + MAX_PAYLOAD + 4;     // 49 bytes, payload zero-padded to 32

const CONTROL_TYPES = new Set([0x01, 0x02, 0x07, 0x0A]); // HELLO, HELLO_ACK, ACK, ABORT

const Packet = (() => {
  function randomTransferId() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  }

  function frameLenForType(type) {
    return CONTROL_TYPES.has(type) ? CONTROL_FRAME_LEN : DATA_FRAME_LEN;
  }

  /**
   * @param {object} fields
   * @param {number} fields.transferId
   * @param {number} fields.type
   * @param {number} fields.sequence
   * @param {number} fields.total
   * @param {Uint8Array} fields.payload
   * @returns {Uint8Array} complete framed packet including CRC32, zero-padded to its fixed frame length
   */
  function create({ transferId, type, sequence, total, payload = new Uint8Array(0) }) {
    if (payload.length > MAX_PAYLOAD) {
      throw new Error(`Payload exceeds MAX_PAYLOAD (${MAX_PAYLOAD} bytes)`);
    }
    const body = new Uint8Array(HEADER_LEN + payload.length);
    const view = new DataView(body.buffer);
    body[0] = MAGIC[0];
    body[1] = MAGIC[1];
    body[2] = VERSION;
    view.setUint32(3, transferId >>> 0, false);
    body[7] = type;
    view.setUint16(8, sequence & 0xFFFF, false);
    view.setUint16(10, total & 0xFFFF, false);
    body[12] = payload.length;
    body.set(payload, HEADER_LEN);

    const crc = CRC32.calculate(body);
    const framed = new Uint8Array(body.length + 4);
    framed.set(body, 0);
    new DataView(framed.buffer).setUint32(body.length, crc, false);

    const targetLen = frameLenForType(type);
    if (framed.length >= targetLen) return framed.slice(0, targetLen);
    const padded = new Uint8Array(targetLen); // zero-padded tail, ignored by parse()
    padded.set(framed, 0);
    return padded;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {object|null} parsed packet, or null if magic/CRC/length invalid
   */
  function parse(bytes) {
    if (bytes.length < HEADER_LEN + 4) return null;
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null;

    const payloadLen = bytes[12];
    const expectedLen = HEADER_LEN + payloadLen + 4;
    if (bytes.length < expectedLen) return null;

    const body = bytes.subarray(0, HEADER_LEN + payloadLen);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const crcReceived = view.getUint32(HEADER_LEN + payloadLen, false);

    if (!CRC32.verify(body, crcReceived)) {
      return { valid: false, reason: 'CRC_MISMATCH' };
    }

    return {
      valid: true,
      version: bytes[2],
      transferId: view.getUint32(3, false),
      type: bytes[7],
      typeName: PacketTypeName[bytes[7]] || 'UNKNOWN',
      sequence: view.getUint16(8, false),
      total: view.getUint16(10, false),
      payload: bytes.slice(HEADER_LEN, HEADER_LEN + payloadLen),
      length: expectedLen,
    };
  }

  return {
    create,
    parse,
    randomTransferId,
    frameLenForType,
    MAX_PAYLOAD,
    HEADER_LEN,
    CONTROL_FRAME_LEN,
    DATA_FRAME_LEN,
  };
})();
