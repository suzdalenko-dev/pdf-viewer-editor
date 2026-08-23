import assert from 'node:assert/strict';
import test from 'node:test';
import { TextDecoder, TextEncoder } from 'node:util';
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

    engine.addOcrTextLayer(0, [
      { text: 'Escaneado', rect: [30, 100, 110, 122] },
      { text: 'Жизнь', rect: [30, 130, 90, 152] },
      { text: '日本語', rect: [30, 160, 90, 182] },
      { text: '한글', rect: [30, 190, 80, 212] }
    ], 'jpn');
    for (const text of ['Escaneado', 'Жизнь', '日本語', '한글']) {
      assert.equal(engine.search(text).length, 1);
    }
    engine.addRedaction(0, [28, 98, 112, 124]);
    engine.applyRedactions(0);
    assert.equal(engine.search('Escaneado').length, 0);

    const image = engine.exportPageImage(0, 'png', 36);
    assert.deepEqual(engine.getImageDimensions(image), { width: 150, height: 200 });
    engine.addImage(0, [170, 40, 250, 120], image);
    const imageAnnotation = engine.getPageModel(0).annotations
      .find((annotation) => annotation.type === 'Stamp');
    assert.ok(imageAnnotation);
    engine.replaceAnnotationImage(0, imageAnnotation.index, imageAnnotation.rect, image);

    engine.addAttachment('proof.txt', 'text/plain', new TextEncoder().encode('local'));
    assert.equal(engine.listAttachments().some(({ name }) => name === 'proof.txt'), true);
    assert.equal(new TextDecoder().decode(engine.extractAttachment('proof.txt')), 'local');
    engine.deleteAttachment('proof.txt');
    assert.equal(engine.listAttachments().length, 0);

    engine.setMetadata({ title: 'PDF test' });
    assert.equal(engine.getMetadata().title, 'PDF test');

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
    engine.mergePdf(createOnePagePdf(), 1);
    assert.equal(engine.countPages(), 2);
    engine.addBlankPage(0);
    assert.equal(engine.countPages(), 3);
    engine.duplicatePage(0);
    assert.equal(engine.countPages(), 4);
    engine.reorderPage(3, 0);
    engine.rotatePage(0, 90);
    engine.cropPage(0, [0, 0, 200, 200]);

    const split = engine.exportPages([0, 3]);
    const splitDocument = mupdf.Document.openDocument(split, 'application/pdf');
    try {
      assert.equal(splitDocument.countPages(), 2);
    } finally {
      splitDocument.destroy();
    }

    const png = engine.exportPageImage(0, 'png', 72);
    assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    engine.deletePage(1);
    assert.equal(engine.countPages(), 3);
  } finally {
    engine.destroy();
  }
});
