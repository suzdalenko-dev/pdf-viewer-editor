import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  base64ToBytes,
  clamp,
  quadToRect,
  transformPoint
} from '../media/webview/utils.js';

test('viewer geometry helpers transform points and search quadrilaterals', () => {
  assert.equal(clamp(12, 0, 10), 10);
  assert.deepEqual(
    quadToRect([20, 40, 10, 5, 22, 44, 8, 7]),
    [8, 5, 22, 44]
  );
  assert.deepEqual(transformPoint([2, 0, 0, 2, -5, 3], [10, 20]), [15, 43]);
});

test('webview base64 transport decodes arbitrary bytes', () => {
  const encoded = Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString('base64');
  assert.deepEqual([...base64ToBytes(encoded)], [0, 1, 2, 127, 128, 254, 255]);
});
