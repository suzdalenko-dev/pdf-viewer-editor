import assert from 'node:assert/strict';
import test from 'node:test';
import mupdf from '../media/vendor/mupdf/mupdf.js';
import { PdfEngine } from '../media/webview/pdf-engine.js';

function createOnePagePdf(saveOptions = 'garbage=4,compress=yes') {
  const document = new mupdf.PDFDocument();
  const resources = document.newDictionary();
  const fonts = document.newDictionary();
  const font = new mupdf.Font('Helvetica');
  const fontReference = document.addSimpleFont(font, 'Latin');
  fonts.put('F0', fontReference);
  resources.put('Font', fonts);
  const page = document.addPage(
    [0, 0, 300, 400],
    0,
    resources,
    'BT /F0 18 Tf 30 350 Td (Original text) Tj ET'
  );
  document.insertPage(-1, page);
  const buffer = document.saveToBuffer(saveOptions);
  const bytes = new Uint8Array(buffer.asUint8Array()).slice();

  buffer.destroy();
  page.destroy();
  fontReference.destroy();
  font.destroy();
  fonts.destroy();
  resources.destroy();
  document.destroy();
  return bytes;
}

test('password-protected PDFs require and accept authentication', () => {
  const engine = new PdfEngine();
  try {
    const result = engine.load(createOnePagePdf(
      'encrypt=aes-256,user-password=user-secret,owner-password=owner-secret'
    ));
    assert.equal(result.passwordRequired, true);
    assert.equal(engine.unlock('wrong'), false);
    assert.equal(engine.unlock('user-secret'), true);
    assert.equal(engine.getDocumentInfo().pageCount, 1);
  } finally {
    engine.destroy();
  }
});

test('read-only engine opens, renders, thumbnails, and searches a PDF', () => {
  const engine = new PdfEngine();
  try {
    const info = engine.load(createOnePagePdf());
    assert.deepEqual(info, { passwordRequired: false, pageCount: 1 });
    assert.deepEqual(engine.getPageBounds(0), [0, 0, 300, 400]);

    const results = engine.search('Original');
    assert.equal(results.length, 1);
    assert.equal(results[0].pageIndex, 0);
    assert.equal(results[0].rect.length, 4);

    const render = engine.renderPage(0, 1, 2_000_000);
    assert.equal(render.width, 300);
    assert.equal(render.height, 400);
    assert.equal(render.pixels.length, 300 * 400 * 4);
    assert.deepEqual(render.pixelBounds, [0, 0, 300, 400]);
    assert.deepEqual(
      render.pageToScreen.map((value) => Object.is(value, -0) ? 0 : value),
      [1, 0, 0, 1, 0, 0]
    );

    const thumbnail = engine.renderThumbnail(0, 120);
    assert.equal(thumbnail[0], 0xff);
    assert.equal(thumbnail[1], 0xd8);
  } finally {
    engine.destroy();
  }
});

test('public engine API contains no PDF mutation or serialization operations', () => {
  const methods = Object.getOwnPropertyNames(PdfEngine.prototype);
  for (const forbidden of [
    'serialize', 'save', 'editTextBlock', 'editTextRange', 'insertTextBlock',
    'insertImageBlock', 'insertTableBlock', 'deleteAnnotation', 'deletePage',
    'rotatePage', 'reorderPage', 'mergePdf', 'updateAnnotation', 'addText'
  ]) {
    assert.equal(methods.includes(forbidden), false, `${forbidden} must not be exposed`);
  }
});
