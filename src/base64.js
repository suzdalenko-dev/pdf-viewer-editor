'use strict';

/**
 * Convert binary document data to a transport-safe base64 string.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Convert a base64 transport string back to document bytes.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
function base64ToBytes(value) {
  const buffer = Buffer.from(value, 'base64');
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
}

module.exports = {
  base64ToBytes,
  bytesToBase64
};
