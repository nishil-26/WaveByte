#!/usr/bin/env node
// Concatenates the DSP/protocol core files (which use the same top-level-const,
// browser-global-script style as the web version, on purpose -- so they can be
// diffed 1:1 against wavebyte's js/ files to prove the CLI runs identical
// modem/packet/FEC/CRC logic) into one CommonJS module. Run after editing any
// file in lib/core-src/.
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'lib', 'core-src');
const FILES = ['crc32.js', 'fec.js', 'packet.js', 'goertzel.js', 'modem.js', 'sha256.js'];

let out = `'use strict';
// GENERATED FILE -- do not edit directly.
// Built by build/make-core-bundle.js from lib/core-src/*.js.
// Those source files are kept byte-identical in spirit to WaveByte's
// browser js/ files (same modem/packet/FEC/CRC logic, zero DOM dependency),
// concatenated here into one shared top-level scope (like separate <script>
// tags in the browser build) and exported for require().

`;

for (const f of FILES) {
  out += `\n// ---- lib/core-src/${f} ----\n`;
  out += fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  out += '\n';
}

out += `
module.exports = { CRC32, FEC, Packet, PacketType, Goertzel, Modem, SHA256 };
`;

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'core.js'), out);
console.log('wrote lib/core.js (' + (out.length / 1024).toFixed(1) + ' KB)');
