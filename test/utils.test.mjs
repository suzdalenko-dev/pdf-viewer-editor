import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeHtml,
  hexToPdfColor,
  invertMatrix,
  normalizeRect,
  parsePageRange,
  pdfColorToHex,
  rectToQuad,
  sanitizeFileStem,
  transformPoint
} from '../media/webview/utils.js';

test('page ranges are one-based, ordered, and deduplicated', () => {
  assert.deepEqual(parsePageRange('1, 3-5, 4', 6), [0, 2, 3, 4]);
  assert.throws(() => parsePageRange('5-2', 6), /descending/);
  assert.throws(() => parsePageRange('7', 6), /outside/);
});

test('PDF geometry helpers normalize rectangles and build quads', () => {
  assert.deepEqual(normalizeRect([20, 40, 10, 5]), [10, 5, 20, 40]);
  assert.deepEqual(rectToQuad([20, 40, 10, 5]), [10, 5, 20, 5, 10, 40, 20, 40]);
});

test('PDF render transformations round-trip without coordinate drift', () => {
  const matrix = [1.375, 0, 0, 1.375, -17, -29];
  const point = [83.25, 147.75];
  const rendered = transformPoint(matrix, point);
  const restored = transformPoint(invertMatrix(matrix), rendered);
  assert.ok(Math.abs(restored[0] - point[0]) < 1e-9);
  assert.ok(Math.abs(restored[1] - point[1]) < 1e-9);
});

test('color and safe-output helpers produce stable values', () => {
  assert.deepEqual(hexToPdfColor('#ff8000'), [1, 128 / 255, 0]);
  assert.equal(pdfColorToHex([1, 128 / 255, 0]), '#ff8000');
  assert.equal(escapeHtml('<PDF & "text">'), '&lt;PDF &amp; &quot;text&quot;&gt;');
  assert.equal(sanitizeFileStem('bad/name\u0001.pdf'), 'bad_name_.pdf'.replace(/\.pdf$/, ''));
});
