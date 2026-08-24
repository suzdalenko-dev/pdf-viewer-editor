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

function createFlowingTextPdf() {
  const document = new mupdf.PDFDocument();
  const resources = document.newDictionary();
  const fonts = document.newDictionary();
  const font = new mupdf.Font('Helvetica');
  const fontReference = document.addSimpleFont(font, 'Latin');
  fonts.put('F0', fontReference);
  resources.put('Font', fonts);
  const contents = [
    'BT /F0 12 Tf',
    '30 365 Td (First paragraph has enough words) Tj',
    '0 -15 Td (to occupy two original lines.) Tj',
    'ET',
    'BT /F0 12 Tf',
    '30 285 Td (Second paragraph must move down.) Tj',
    'ET',
    'BT /F0 12 Tf',
    '30 235 Td (Third paragraph follows the flow.) Tj',
    'ET'
  ].join('\n');
  const page = document.addPage([0, 0, 300, 420], 0, resources, contents);
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

function createMergedParagraphPdf() {
  const document = new mupdf.PDFDocument();
  const resources = document.newDictionary();
  const fonts = document.newDictionary();
  const font = new mupdf.Font('Helvetica');
  const fontReference = document.addSimpleFont(font, 'Latin');
  fonts.put('F0', fontReference);
  resources.put('Font', fonts);
  const contents = [
    'BT /F0 12 Tf',
    '30 365 Td (First visual paragraph starts here) Tj',
    '0 -15 Td (and continues on its second line.) Tj',
    '0 -42 Td (Second visual paragraph starts after a gap) Tj',
    '0 -15 Td (and has another wrapped line.) Tj',
    'ET'
  ].join('\n');
  const page = document.addPage([0, 0, 300, 420], 0, resources, contents);
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

test('text blocks reflow, move following content, and remain searchable', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createFlowingTextPdf());
    const originalModel = engine.getPageModel(0);
    const firstBlock = originalModel.textBlocks.find((block) => block.text.includes('First paragraph'));
    const originalSecondLine = originalModel.textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(firstBlock);
    assert.ok(originalSecondLine);

    const editResult = engine.editTextBlock(0, firstBlock.index, {
      text: 'Edited flowing paragraph now contains substantially more words so it wraps onto several lines and creates real space below itself.',
      fontFamily: 'Helvetica',
      fontSize: 20,
      color: [0.1, 0.2, 0.7]
    });
    assert.ok(editResult.delta > 0);
    assert.equal(engine.search('First paragraph').length, 0);
    assert.equal(engine.search('Edited flowing').length, 1);

    const editedModel = engine.getPageModel(0);
    const shiftedSecondLine = editedModel.textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(shiftedSecondLine.rect[1] > originalSecondLine.rect[1]);

    const editedBlock = editedModel.textBlocks.find((block) => block.text.includes('Edited flowing'));
    assert.ok(editedBlock);
    const secondBeforeDelete = shiftedSecondLine.rect[1];
    engine.editTextBlock(0, editedBlock.index, { text: '' });
    assert.equal(engine.search('Edited flowing').length, 0);
    const secondAfterDelete = engine.getPageModel(0).textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(secondAfterDelete.rect[1] < secondBeforeDelete);

    const saved = engine.serialize('clean');
    const reopened = new PdfEngine();
    try {
      reopened.load(saved);
      assert.equal(reopened.search('Second paragraph').length, 1);
      assert.equal(reopened.search('Edited flowing').length, 0);
    } finally {
      reopened.destroy();
    }
  } finally {
    engine.destroy();
  }
});

test('visual paragraph detection avoids one giant selection block', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createMergedParagraphPdf());
    const model = engine.getPageModel(0);
    assert.equal(model.textBlocks.length, 2);
    assert.equal(model.textLines.length, 4);
    assert.equal(model.textBlocks[0].visualLines.length, 2);
    assert.equal(model.textBlocks[1].visualLines.length, 2);
    assert.equal(model.textLines[0].blockIndex, model.textLines[1].blockIndex);
    assert.notEqual(model.textLines[1].blockIndex, model.textLines[2].blockIndex);
    assert.ok(model.textBlocks[0].rect[3] < model.textBlocks[1].rect[1]);
  } finally {
    engine.destroy();
  }
});

test('a selected text range can change content and format with real reflow', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createFlowingTextPdf());
    const originalModel = engine.getPageModel(0);
    const firstBlock = originalModel.textBlocks.find((block) =>
      block.text.includes('First paragraph')
    );
    const originalSecond = originalModel.textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    const start = firstBlock.text.indexOf('paragraph');
    const result = engine.editTextRange(
      0,
      firstBlock.index,
      start,
      start + 'paragraph'.length,
      'much larger selected passage that wraps',
      { fontFamily: 'Times-Roman', fontSize: 28, color: [0.8, 0.1, 0.1] }
    );
    assert.ok(result.delta > 0);
    assert.equal(engine.search('First').length, 1);
    assert.equal(engine.search('much larger selected').length, 1);
    assert.equal(engine.search('First paragraph').length, 0);
    const shiftedSecond = engine.getPageModel(0).textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(shiftedSecond.rect[1] > originalSecond.rect[1]);
  } finally {
    engine.destroy();
  }
});

test('flow image and table insertion move lower text instead of covering it', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createFlowingTextPdf());
    const originalSecond = engine.getPageModel(0).textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    const imageBytes = engine.exportPageImage(0, 'png', 24);
    const imageResult = engine.insertImageBlock(0, [30, 90, 150, 150], imageBytes);
    assert.ok(imageResult.shiftedBlocks > 0);
    const afterImage = engine.getPageModel(0);
    const imageShiftedSecond = afterImage.textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(imageShiftedSecond.rect[1] > originalSecond.rect[1]);
    assert.ok(afterImage.annotations.some((annotation) => annotation.type === 'Stamp'));

    const tableResult = engine.insertTableBlock(0, [30, 155, 270, 225], 3, 4);
    assert.ok(tableResult.shiftedBlocks > 0);
    const afterTable = engine.getPageModel(0);
    const tableShiftedSecond = afterTable.textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(tableShiftedSecond.rect[1] > imageShiftedSecond.rect[1]);
    assert.ok(afterTable.annotations.some((annotation) => annotation.table));
  } finally {
    engine.destroy();
  }
});

test('text insertion, free positioning, and editable tables work as PDF objects', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createFlowingTextPdf());
    const originalSecond = engine.getPageModel(0).textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    engine.insertTextBlock(0, [30, 90, 250, 90], {
      text: 'New text placed anywhere on the page.',
      fontSize: 14,
      fontFamily: 'Times-Roman'
    });
    assert.equal(engine.search('New text placed').length, 1);
    const insertedModel = engine.getPageModel(0);
    const shiftedSecond = insertedModel.textLines.find((line) =>
      line.text.includes('Second paragraph')
    );
    assert.ok(shiftedSecond.rect[1] > originalSecond.rect[1]);

    const insertedBlock = insertedModel.textBlocks.find((block) =>
      block.text.includes('New text placed')
    );
    engine.moveTextBlock(0, insertedBlock.index, [80, 55, 250, 80]);
    const movedLine = engine.getPageModel(0).textLines.find((line) =>
      line.text.includes('New text placed')
    );
    assert.ok(movedLine.rect[0] >= 79);

    engine.addTable(0, [30, 250, 270, 350], 3, 4);
    let table = engine.getPageModel(0).annotations.find((annotation) => annotation.table);
    assert.deepEqual(
      { rows: table.table.rows, columns: table.table.columns },
      { rows: 3, columns: 4 }
    );
    engine.updateTable(0, table.index, [35, 245, 265, 355], 4, 2);
    table = engine.getPageModel(0).annotations.find((annotation) => annotation.table);
    assert.deepEqual(
      { rows: table.table.rows, columns: table.table.columns },
      { rows: 4, columns: 2 }
    );
    engine.deleteAnnotation(0, table.index);
    assert.equal(engine.getPageModel(0).annotations.some((annotation) => annotation.table), false);
  } finally {
    engine.destroy();
  }
});


test('v0.0.7 text edits honor a new bounding box width and position', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createFlowingTextPdf());
    const original = engine.getPageModel(0).textBlocks.find((block) =>
      block.text.includes('First paragraph')
    );
    assert.ok(original);
    const targetRect = [62, original.rect[1] + 4, 176, original.rect[3] + 4];
    const result = engine.editTextBlock(0, original.index, {
      text: 'First paragraph edited inside a deliberately narrower resizable box with enough words to wrap.',
      fontFamily: 'Helvetica',
      fontSize: 12,
      targetRect
    });
    assert.ok(Math.abs(result.rect[0] - targetRect[0]) < 0.01);
    assert.ok(Math.abs(result.rect[2] - targetRect[2]) < 0.01);
    const edited = engine.getPageModel(0).textBlocks.find((block) =>
      block.text.includes('deliberately narrower')
    );
    assert.ok(edited);
    assert.ok(edited.rect[0] >= targetRect[0] - 3);
    assert.ok(edited.rect[2] <= targetRect[2] + 3);
  } finally {
    engine.destroy();
  }
});

test('v0.0.7 table metadata keeps the blue selection rectangle equal to the table', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createOnePagePdf());
    const initialRect = [42, 90, 242, 190];
    engine.addTable(0, initialRect, 3, 4, { borderWidth: 1.5 });
    let table = engine.getPageModel(0).annotations.find((annotation) => annotation.table);
    assert.ok(table);
    assert.deepEqual(table.rect.map((value) => Math.round(value)), initialRect);

    const resizedRect = [55, 105, 270, 235];
    engine.updateTable(0, table.index, resizedRect, 4, 5, { borderWidth: 2 });
    table = engine.getPageModel(0).annotations.find((annotation) => annotation.table);
    assert.ok(table);
    assert.deepEqual(table.rect.map((value) => Math.round(value)), resizedRect);
    assert.equal(table.table.rows, 4);
    assert.equal(table.table.columns, 5);
  } finally {
    engine.destroy();
  }
});
