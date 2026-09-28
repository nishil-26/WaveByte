#!/usr/bin/env node
// Concatenates lib/protocol-src/*.js (transmitter/receiver/file-transfer/
// calibration -- copied byte-for-byte from WaveByte's browser js/ files;
// none of them touch window/document/navigator, so none needed changes) into
// one CommonJS module, in front of a preamble that provides the same
// Modem/Packet/PacketType/FEC/CRC32/SHA256/WBAudio bare names those files
// reference, via require('./core.js') and require('./audio-node.js'). Run
// after editing any file in lib/protocol-src/.
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'lib', 'protocol-src');
const FILES = ['transmitter.js', 'receiver.js', 'file-transfer.js', 'calibration.js'];

let out = `'use strict';
// GENERATED FILE -- do not edit directly.
// Built by build/make-protocol-bundle.js from lib/protocol-src/*.js.
// Those source files are copied unchanged from WaveByte's browser js/
// files -- same HELLO/CAPABILITIES/START_TRANSFER/DATA/ACK-NACK/END_TRANSFER
// state machine, same ARQ/FEC/CRC/SHA-256 logic -- on top of core.js and
// this CLI's sox-backed audio-node.js in place of the browser's Web Audio
// layer.
const { CRC32, FEC, Packet, PacketType, Goertzel, Modem, SHA256 } = require('./core.js');
const WBAudio = require('./audio-node.js');
`;

for (const f of FILES) {
  out += `\n// ---- lib/protocol-src/${f} ----\n`;
  out += fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  out += '\n';
}

out += `
module.exports = { Transmitter, Receiver, FileTransfer, Calibration };
`;

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'protocol.js'), out);
console.log('wrote lib/protocol.js (' + (out.length / 1024).toFixed(1) + ' KB)');
