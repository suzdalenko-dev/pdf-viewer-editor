import assert from 'node:assert/strict';
import test from 'node:test';
import mupdf from '../media/vendor/mupdf/mupdf.js';
import { PdfEngine } from '../media/webview/pdf-engine.js';

function createOnePagePdf() {
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
  const buffer = document.saveToBuffer('garbage=4,compress=yes');
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

test('MuPDF engine opens, renders, searches, edits, and serializes a PDF', () => {
  const engine = new PdfEngine();
  try {
    const info = engine.load(createOnePagePdf());
    assert.equal(info.pageCount, 1);
    assert.equal(info.passwordRequired, false);
    assert.equal(engine.search('Original').length, 1);

    const render = engine.renderPage(0, 1, 2_000_000);
    assert.equal(render.width, 300);
    assert.equal(render.height, 400);
    assert.equal(render.pixels.length, 300 * 400 * 4);
    assert.deepEqual([...engine.renderThumbnail(0).slice(0, 2)], [0xff, 0xd8]);

    const originalTextRect = engine.getPageModel(0).textLines[0].rect;
    engine.replaceExistingText(0, originalTextRect, {
      text: 'Edited text',
      font: 'Helv',
      fontSize: 16,
      color: [0.1, 0.2, 0.8]
    });
    assert.equal(engine.search('Original').length, 0);
    const annotations = engine.getPageModel(0).annotations;
    assert.equal(annotations.some((annotation) =>
      annotation.type === 'FreeText' && annotation.contents === 'Edited text'), true);

    engine.addShape(0, {
      type: 'Square',
      rect: [20, 20, 90, 90],
      color: [1, 0, 0],
      fillColor: [1, 1, 0],
      borderWidth: 2,
      opacity: 0.7
    });
    assert.equal(engine.getPageModel(0).annotations.length >= 2, true);

    const saved = engine.serialize('clean');
    assert.equal(String.fromCharCode(...saved.slice(0, 5)), '%PDF-');

    const reopened = new PdfEngine();
    try {
      assert.equal(reopened.load(saved).pageCount, 1);
      assert.equal(reopened.getPageModel(0).annotations.length >= 2, true);
    } finally {
      reopened.destroy();
    }
  } finally {
    engine.destroy();
  }
});

test('page management and export preserve valid PDF documents', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createOnePagePdf());
    engine.addBlankPage(0);
    assert.equal(engine.countPages(), 2);
    engine.duplicatePage(0);
    assert.equal(engine.countPages(), 3);
    engine.reorderPage(2, 0);
    engine.rotatePage(0, 90);
    engine.cropPage(0, [0, 0, 200, 200]);

    const split = engine.exportPages([0, 2]);
    const splitDocument = mupdf.Document.openDocument(split, 'application/pdf');
    try {
      assert.equal(splitDocument.countPages(), 2);
    } finally {
      splitDocument.destroy();
    }

    const png = engine.exportPageImage(0, 'png', 72);
    assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    engine.deletePage(1);
    assert.equal(engine.countPages(), 2);
  } finally {
    engine.destroy();
  }
});
