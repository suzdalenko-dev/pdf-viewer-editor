'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { base64ToBytes, bytesToBase64 } = require('../src/base64');

test('extension-host base64 transport preserves arbitrary bytes', () => {
  const input = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  const encoded = bytesToBase64(input);
  const output = base64ToBytes(encoded);

  assert.deepEqual([...output], [...input]);
});
