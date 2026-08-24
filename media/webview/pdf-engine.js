import mupdf from '../vendor/mupdf/mupdf.js';
import {
  normalizeRect,
  quadToRect,
  rectFromBbox,
  rectToQuad,
  transformPoint
} from './utils.js';

const DEFAULT_TEXT_PROPERTIES = Object.freeze({
  font: 'Helv',
  fontFamily: 'Helvetica',
  fontSize: 12,
  color: [0, 0, 0],
  alignment: 0,
  bold: false,
  italic: false,
  opacity: 1
});
const TABLE_SUBJECT = 'PDF Viewer Editor Table';

export class PdfEngine {
  constructor() {
    this.document = null;
    this.pdfDocument = null;
    this.passwordAccepted = false;
  }

  destroy() {
    try {
      this.pdfDocument?.destroy();
    } catch {
      // The underlying document may already have released the PDF wrapper.
    }
    try {
      this.document?.destroy();
    } catch {
      // Ignore repeated destruction while reloading a document.
    }
    this.pdfDocument = null;
    this.document = null;
    this.passwordAccepted = false;
  }

  load(bytes, password = '') {
    this.destroy();
    const document = mupdf.Document.openDocument(bytes, 'application/pdf');
    if (!document.isPDF()) {
      document.destroy();
      throw new Error('The selected file is not a valid PDF document.');
    }

    this.document = document;
    this.pdfDocument = document.asPDF();
    this.pdfDocument.disableJS();

    if (document.needsPassword()) {
      if (!password) {
        return { passwordRequired: true };
      }
      const authentication = document.authenticatePassword(password);
      if (authentication === 0) {
        return { passwordRequired: true, invalidPassword: true };
      }
      this.passwordAccepted = true;
    }

    this.pdfDocument.enableJournal();
    return this.getDocumentInfo();
  }

  unlock(password) {
    this.assertLoaded();
    const result = this.document.authenticatePassword(password);
    if (result === 0) {
      return false;
    }
    this.passwordAccepted = true;
    this.pdfDocument.enableJournal();
    return true;
  }

  getDocumentInfo() {
    this.assertUnlocked();
    return {
      passwordRequired: false,
      pageCount: this.document.countPages(),
      permissions: {
        edit: this.document.hasPermission('edit'),
        annotate: this.document.hasPermission('annotate'),
        copy: this.document.hasPermission('copy'),
        assemble: this.document.hasPermission('assemble'),
        form: this.document.hasPermission('form')
      },
      metadata: this.getMetadata(),
      outline: this.getOutline()
    };
  }

  countPages() {
    this.assertUnlocked();
    return this.document.countPages();
  }

  renderPage(pageIndex, requestedScale, maxRenderPixels, showExtras = true) {
    this.assertPageIndex(pageIndex);
    const page = this.pdfDocument.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const widthInPoints = Math.max(1, bounds[2] - bounds[0]);
      const heightInPoints = Math.max(1, bounds[3] - bounds[1]);
      const requestedPixels = widthInPoints * heightInPoints * requestedScale * requestedScale;
      const scale = requestedPixels > maxRenderPixels
        ? Math.sqrt(maxRenderPixels / (widthInPoints * heightInPoints))
        : requestedScale;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        true,
        showExtras
      );
      try {
        return {
          width: pixmap.getWidth(),
          height: pixmap.getHeight(),
          pixels: new Uint8ClampedArray(pixmap.getPixels()).slice(),
          bounds: [...bounds],
          scale
        };
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  renderThumbnail(pageIndex, maximumWidth = 160) {
    this.assertPageIndex(pageIndex);
    const page = this.pdfDocument.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const width = Math.max(1, bounds[2] - bounds[0]);
      const scale = Math.min(0.35, maximumWidth / width);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );
      try {
        return new Uint8Array(pixmap.asJPEG(72)).slice();
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  getPageModel(pageIndex) {
    this.assertPageIndex(pageIndex);
    const page = this.pdfDocument.loadPage(pageIndex);
    try {
      const structuredText = page.toStructuredText('preserve-spans,preserve-images');
      let parsed;
      let textBlocks;
      try {
        parsed = JSON.parse(structuredText.asJSON());
        textBlocks = extractTextBlocks(structuredText);
      } finally {
        structuredText.destroy();
      }

      const images = [];
      for (const block of parsed.blocks || []) {
        if (block.type === 'image') {
          images.push({
            rect: rectFromBbox(block.bbox),
            width: Number(block.width || 0),
            height: Number(block.height || 0)
          });
        }
      }

      return {
        bounds: [...page.getBounds()],
        textBlocks,
        textLines: textBlocks.flatMap((block) => block.visualLines),
        images,
        annotations: this.readAnnotations(page),
        widgets: this.readWidgets(page)
      };
    } finally {
      page.destroy();
    }
  }

  readAnnotations(page) {
    const annotations = page.getAnnotations();
    return annotations.map((annotation, index) => {
      try {
        const type = annotation.getType();
        const contents = safeCall(() => annotation.getContents(), '');
        const subject = safeCall(() => annotation.getSubject(), '');
        const table = parseTableMetadata(type, subject, contents);
        let rect = table?.rect ? [...table.rect] : null;
        if (!rect && table) {
          rect = safeCall(() => [...annotation.getBounds()], null);
        }
        if (!rect) {
          rect = annotation.hasRect()
            ? [...annotation.getRect()]
            : [...annotation.getBounds()];
        }

        let defaultAppearance = null;
        if (type === 'FreeText') {
          try {
            defaultAppearance = annotation.getDefaultAppearance();
          } catch {
            defaultAppearance = null;
          }
        }
        return {
          index,
          type,
          rect,
          contents,
          author: safeCall(() => annotation.getAuthor(), ''),
          subject,
          table,
          color: safeCall(() => [...annotation.getColor()], []),
          interiorColor: annotation.hasInteriorColor()
            ? safeCall(() => [...annotation.getInteriorColor()], [])
            : [],
          opacity: safeCall(() => annotation.getOpacity(), 1),
          borderWidth: annotation.hasBorder()
            ? safeCall(() => annotation.getBorderWidth(), 1)
            : 0,
          alignment: type === 'FreeText'
            ? safeCall(() => annotation.getQuadding(), 0)
            : 0,
          font: defaultAppearance?.font || 'Helv',
          fontSize: defaultAppearance?.size || 12,
          fontColor: defaultAppearance?.color || []
        };
      } finally {
        annotation.destroy();
      }
    });
  }

  readWidgets(page) {
    const widgets = page.getWidgets();
    return widgets.map((widget, index) => {
      try {
        return {
          index,
          type: widget.getFieldType(),
          rect: [...widget.getRect()],
          name: safeCall(() => widget.getName(), ''),
          label: safeCall(() => widget.getLabel(), ''),
          value: safeCall(() => widget.getValue(), ''),
          options: widget.isChoice() ? safeCall(() => widget.getOptions(false), []) : [],
          readOnly: safeCall(() => widget.isReadOnly(), false),
          checkbox: safeCall(() => widget.isCheckbox(), false),
          radio: safeCall(() => widget.isRadioButton(), false),
          text: safeCall(() => widget.isText(), false),
          choice: safeCall(() => widget.isChoice(), false)
        };
      } finally {
        widget.destroy();
      }
    });
  }

  search(query) {
    this.assertUnlocked();
    const results = [];
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return results;
    }

    for (let pageIndex = 0; pageIndex < this.countPages(); pageIndex += 1) {
      const page = this.pdfDocument.loadPage(pageIndex);
      try {
        const hits = page.search(normalizedQuery, 10000);
        for (const quads of hits) {
          const rects = quads.map((quad) => quadToRect(quad));
          results.push({
            pageIndex,
            quads: quads.map((quad) => [...quad]),
            rect: unionRects(rects)
          });
        }
      } finally {
        page.destroy();
      }
    }
    return results;
  }

  addText(pageIndex, rect, properties = {}) {
    const values = { ...DEFAULT_TEXT_PROPERTIES, ...properties };
    this.withOperation('Add text', () => {
      this.withPage(pageIndex, (page) => {
        this.createFreeText(page, rect, values);
      });
    });
  }

  replaceExistingText(pageIndex, rect, properties = {}) {
    const values = { ...DEFAULT_TEXT_PROPERTIES, ...properties };
    this.withOperation('Edit existing text', () => {
      this.withPage(pageIndex, (page) => {
        this.removeContentInRect(page, rect, {
          images: false,
          lineArt: false,
          text: true
        });
        if (String(values.text || '').length > 0) {
          this.createFreeText(page, rect, values);
        }
      });
    });
  }

  /**
   * Replaces one extracted PDF text block with static, searchable page content.
   * The text is wrapped to the original block width and every text block below it
   * in the same visual flow is moved by the resulting height difference.
   */
  editTextBlock(pageIndex, blockIndex, properties = {}) {
    const model = this.getPageModel(pageIndex);
    const block = model.textBlocks.find((candidate) => candidate.index === blockIndex);
    if (!block) {
      throw new Error('The selected text block no longer exists. Select it again.');
    }

    const values = normalizeBlockProperties(block, properties);
    const requested = values.text && Array.isArray(properties.targetRect)
      ? normalizeRect(properties.targetRect)
      : [...block.rect];
    const minimumWidth = Math.max(24, Number(values.fontSize || block.font?.size || 12) * 2);
    const targetRect = [
      requested[0],
      requested[1],
      Math.max(requested[0] + minimumWidth, requested[2]),
      requested[3]
    ];
    const layoutRect = [targetRect[0], targetRect[1], targetRect[2], targetRect[1]];
    const layout = layoutTextBlock(layoutRect, values, block.metrics, block);
    const newBottom = values.text ? targetRect[1] + layout.height : block.rect[1];
    const delta = newBottom - block.rect[3];
    const followingBlocks = findFollowingBlocks(model.textBlocks, block.rect, block.index);
    const shiftedEntries = followingBlocks.flatMap((followingBlock) =>
      textEntriesForExistingBlock(followingBlock, delta)
    );

    this.withOperation(values.text ? 'Edit text block' : 'Delete text block', () => {
      this.withPage(pageIndex, (page) => {
        for (const sourceBlock of [block, ...followingBlocks]) {
          this.removeContentInRect(page, expandRect(sourceBlock.rect, 0.35), {
            images: false,
            lineArt: false,
            text: true
          });
        }

        const entries = values.text
          ? [...layout.entries, ...shiftedEntries]
          : shiftedEntries;
        const maximumBottom = Math.max(
          values.text ? newBottom : block.rect[1],
          ...followingBlocks.map((candidate) => candidate.rect[3] + delta)
        );
        this.extendPageToFit(page, maximumBottom);
        this.appendStaticText(page, entries);
      });
    });

    return {
      delta,
      shiftedBlocks: followingBlocks.length,
      rect: values.text
        ? [targetRect[0], targetRect[1], targetRect[2], newBottom]
        : [block.rect[0], block.rect[1], block.rect[2], block.rect[1]]
    };
  }

  /**
   * Replaces an arbitrary character range inside an extracted text block. The
   * complete paragraph is reflowed afterwards, so a longer replacement or a
   * larger font creates real room and moves the following content down.
   */
  editTextRange(pageIndex, blockIndex, start, end, replacement, properties = {}) {
    const model = this.getPageModel(pageIndex);
    const block = model.textBlocks.find((candidate) => candidate.index === blockIndex);
    if (!block) {
      throw new Error('The selected text block no longer exists. Select it again.');
    }

    const rangeStart = Math.max(0, Math.min(block.text.length, Math.round(Number(start) || 0)));
    const rangeEnd = Math.max(
      rangeStart,
      Math.min(block.text.length, Math.round(Number(end) || 0))
    );
    const replacementText = String(replacement || '').replaceAll('\0', '');
    const originalValues = normalizeBlockProperties(block, { text: block.text });
    const replacementValues = normalizeBlockProperties(block, {
      ...properties,
      text: replacementText
    });
    const runs = [
      { text: block.text.slice(0, rangeStart), values: originalValues },
      { text: replacementText, values: replacementValues },
      { text: block.text.slice(rangeEnd), values: originalValues }
    ].filter((run) => run.text.length > 0);
    const resultingText = runs.map((run) => run.text).join('');
    const layout = layoutRichTextBlock(
      block.rect,
      runs,
      block.metrics,
      replacementValues.alignment
    );
    const oldHeight = Math.max(0, block.rect[3] - block.rect[1]);
    const delta = layout.height - oldHeight;
    const followingBlocks = findFollowingBlocks(model.textBlocks, block.rect, block.index);
    const shiftedEntries = followingBlocks.flatMap((followingBlock) =>
      textEntriesForExistingBlock(followingBlock, delta)
    );

    this.withOperation(resultingText ? 'Edit text selection' : 'Delete text selection', () => {
      this.withPage(pageIndex, (page) => {
        for (const sourceBlock of [block, ...followingBlocks]) {
          this.removeContentInRect(page, expandRect(sourceBlock.rect, 0.35), {
            images: false,
            lineArt: false,
            text: true
          });
        }
        const entries = resultingText
          ? [...layout.entries, ...shiftedEntries]
          : shiftedEntries;
        const maximumBottom = Math.max(
          resultingText ? block.rect[1] + layout.height : block.rect[1],
          ...followingBlocks.map((candidate) => candidate.rect[3] + delta)
        );
        this.extendPageToFit(page, maximumBottom);
        this.appendStaticText(page, entries);
      });
    });

    return {
      delta,
      shiftedBlocks: followingBlocks.length,
      text: resultingText,
      rect: [block.rect[0], block.rect[1], block.rect[2], block.rect[1] + layout.height]
    };
  }

  /**
   * Inserts a new static text block and makes room by moving intersecting text
   * blocks and all lower blocks in the same visual column.
   */
  insertTextBlock(pageIndex, rect, properties = {}) {
    const model = this.getPageModel(pageIndex);
    const normalizedRect = normalizeRect(rect);
    const seedBlock = {
      font: {
        editableFamily: 'Helvetica',
        bold: false,
        italic: false,
        size: 12
      },
      color: [0, 0, 0],
      alignment: 0,
      text: '',
      visualLines: [],
      metrics: defaultTextMetrics(12)
    };
    const values = normalizeBlockProperties(seedBlock, properties);
    if (!values.text.trim()) {
      return { delta: 0, shiftedBlocks: 0, rect: normalizedRect };
    }

    const width = Math.max(48, normalizedRect[2] - normalizedRect[0]);
    const anchorRect = [
      normalizedRect[0],
      normalizedRect[1],
      normalizedRect[0] + width,
      normalizedRect[1]
    ];
    const layout = layoutTextBlock(anchorRect, values, defaultTextMetrics(values.fontSize));
    const spacing = Math.max(4, values.fontSize * 0.4);
    const delta = layout.height + spacing;
    const followingBlocks = findBlocksAtOrBelow(model.textBlocks, anchorRect);
    const shiftedEntries = followingBlocks.flatMap((followingBlock) =>
      textEntriesForExistingBlock(followingBlock, delta)
    );

    this.withOperation('Add text block', () => {
      this.withPage(pageIndex, (page) => {
        for (const sourceBlock of followingBlocks) {
          this.removeContentInRect(page, expandRect(sourceBlock.rect, 0.35), {
            images: false,
            lineArt: false,
            text: true
          });
        }

        const maximumBottom = Math.max(
          anchorRect[1] + layout.height,
          ...followingBlocks.map((candidate) => candidate.rect[3] + delta)
        );
        this.extendPageToFit(page, maximumBottom);
        this.appendStaticText(page, [...layout.entries, ...shiftedEntries]);
      });
    });

    return {
      delta,
      shiftedBlocks: followingBlocks.length,
      rect: [anchorRect[0], anchorRect[1], anchorRect[2], anchorRect[1] + layout.height]
    };
  }

  /**
   * Inserts an image as a flow object. Text intersecting the insertion point
   * and all text below it in the same column is rewritten lower on the page.
   */
  insertImageBlock(pageIndex, rect, imageBytes) {
    return this.insertFlowObject(pageIndex, rect, 'Add image block', (page, targetRect) => {
      this.createImageStamp(page, targetRect, imageBytes);
    });
  }

  /**
   * Inserts an editable table as a flow object and makes room for it by moving
   * lower text blocks instead of covering them.
   */
  insertTableBlock(pageIndex, rect, rows = 2, columns = 2, properties = {}) {
    const rowCount = Math.max(1, Math.min(30, Math.round(Number(rows) || 2)));
    const columnCount = Math.max(1, Math.min(20, Math.round(Number(columns) || 2)));
    return this.insertFlowObject(pageIndex, rect, 'Add table block', (page, targetRect) => {
      this.createTableAnnotation(page, targetRect, rowCount, columnCount, properties);
    });
  }

  insertFlowObject(pageIndex, rect, label, createObject) {
    const model = this.getPageModel(pageIndex);
    const normalizedRect = normalizeRect(rect);
    const objectHeight = Math.max(8, normalizedRect[3] - normalizedRect[1]);
    const spacing = 6;
    const delta = objectHeight + spacing;
    const anchorRect = [
      normalizedRect[0],
      normalizedRect[1],
      normalizedRect[2],
      normalizedRect[1]
    ];
    const followingBlocks = findBlocksAtOrBelow(model.textBlocks, anchorRect);
    const shiftedEntries = followingBlocks.flatMap((followingBlock) =>
      textEntriesForExistingBlock(followingBlock, delta)
    );

    this.withOperation(label, () => {
      this.withPage(pageIndex, (page) => {
        for (const sourceBlock of followingBlocks) {
          this.removeContentInRect(page, expandRect(sourceBlock.rect, 0.35), {
            images: false,
            lineArt: false,
            text: true
          });
        }
        const maximumBottom = Math.max(
          normalizedRect[3],
          ...followingBlocks.map((candidate) => candidate.rect[3] + delta)
        );
        this.extendPageToFit(page, maximumBottom);
        this.appendStaticText(page, shiftedEntries);
        createObject(page, normalizedRect);
      });
    });

    return {
      delta,
      shiftedBlocks: followingBlocks.length,
      rect: normalizedRect
    };
  }

  resizeTextBlock(pageIndex, blockIndex, targetRect) {
    const model = this.getPageModel(pageIndex);
    const block = model.textBlocks.find((candidate) => candidate.index === blockIndex);
    if (!block) {
      throw new Error('The selected text block no longer exists. Select it again.');
    }

    const target = normalizeRect(targetRect);
    const minimumWidth = Math.max(36, Number(block.font?.size || 12) * 3);
    const width = Math.max(minimumWidth, target[2] - target[0]);
    const layoutRect = [target[0], target[1], target[0] + width, target[1]];
    const values = normalizeBlockProperties(block, { text: block.text });
    const layout = layoutTextBlock(layoutRect, values, block.metrics, block);
    const newBottom = layoutRect[1] + layout.height;
    const delta = newBottom - block.rect[3];
    const followingBlocks = findFollowingBlocks(model.textBlocks, block.rect, block.index);
    const shiftedEntries = followingBlocks.flatMap((followingBlock) =>
      textEntriesForExistingBlock(followingBlock, delta)
    );

    this.withOperation('Resize text block', () => {
      this.withPage(pageIndex, (page) => {
        for (const sourceBlock of [block, ...followingBlocks]) {
          this.removeContentInRect(page, expandRect(sourceBlock.rect, 0.35), {
            images: false,
            lineArt: false,
            text: true
          });
        }
        this.extendPageToFit(page, Math.max(
          newBottom,
          ...followingBlocks.map((candidate) => candidate.rect[3] + delta)
        ));
        this.appendStaticText(page, [...layout.entries, ...shiftedEntries]);
      });
    });

    return {
      delta,
      shiftedBlocks: followingBlocks.length,
      rect: [layoutRect[0], layoutRect[1], layoutRect[2], newBottom]
    };
  }

  moveTextBlock(pageIndex, blockIndex, targetRect) {
    const model = this.getPageModel(pageIndex);
    const block = model.textBlocks.find((candidate) => candidate.index === blockIndex);
    if (!block) {
      throw new Error('The selected text block no longer exists. Select it again.');
    }

    const normalizedTarget = normalizeRect(targetRect);
    const deltaX = normalizedTarget[0] - block.rect[0];
    const deltaY = normalizedTarget[1] - block.rect[1];
    const entries = textEntriesForExistingBlock(block, deltaY, deltaX);
    this.withOperation('Move text block', () => {
      this.withPage(pageIndex, (page) => {
        this.removeContentInRect(page, expandRect(block.rect, 0.35), {
          images: false,
          lineArt: false,
          text: true
        });
        this.extendPageToFit(page, block.rect[3] + deltaY);
        this.appendStaticText(page, entries);
      });
    });
  }

  addTable(pageIndex, rect, rows = 2, columns = 2, properties = {}) {
    const normalizedRect = normalizeRect(rect);
    const rowCount = Math.max(1, Math.min(30, Math.round(Number(rows) || 2)));
    const columnCount = Math.max(1, Math.min(20, Math.round(Number(columns) || 2)));

    this.withOperation('Add table', () => {
      this.withPage(pageIndex, (page) => {
        this.createTableAnnotation(
          page,
          normalizedRect,
          rowCount,
          columnCount,
          properties
        );
      });
    });
  }

  updateTable(pageIndex, annotationIndex, rect, rows, columns, properties = {}) {
    this.withOperation('Edit table', () => {
      this.withPage(pageIndex, (page) => {
        const annotations = page.getAnnotations();
        try {
          const annotation = annotations[annotationIndex];
          if (!annotation) {
            throw new Error('The selected table no longer exists.');
          }
          const metadata = parseTableMetadata(
            annotation.getType(),
            safeCall(() => annotation.getSubject(), ''),
            safeCall(() => annotation.getContents(), '')
          );
          if (!metadata) {
            throw new Error('The selected object is not an editable table.');
          }
          page.deleteAnnotation(annotation);
          this.createTableAnnotation(page, rect, rows, columns, {
            color: properties.color || metadata.color,
            borderWidth: properties.borderWidth || metadata.borderWidth
          });
          page.update();
        } finally {
          destroyAll(annotations);
        }
      });
    });
  }

  createTableAnnotation(page, rect, rows, columns, properties = {}) {
    const normalizedRect = normalizeRect(rect);
    const rowCount = Math.max(1, Math.min(30, Math.round(Number(rows) || 2)));
    const columnCount = Math.max(1, Math.min(20, Math.round(Number(columns) || 2)));
    const color = normalizeColor(properties.color, [0, 0, 0]);
    const borderWidth = Math.max(0.25, Math.min(8, Number(properties.borderWidth || 1)));
    const strokes = [];
    for (let row = 0; row <= rowCount; row += 1) {
      const y = normalizedRect[1] + (
        (normalizedRect[3] - normalizedRect[1]) * row / rowCount
      );
      strokes.push([[normalizedRect[0], y], [normalizedRect[2], y]]);
    }
    for (let column = 0; column <= columnCount; column += 1) {
      const x = normalizedRect[0] + (
        (normalizedRect[2] - normalizedRect[0]) * column / columnCount
      );
      strokes.push([[x, normalizedRect[1]], [x, normalizedRect[3]]]);
    }

    const annotation = page.createAnnotation('Ink');
    try {
      annotation.setInkList(strokes);
      annotation.setColor(color);
      if (annotation.hasBorder()) {
        annotation.setBorderWidth(borderWidth);
      }
      annotation.setAuthor('PDF Viewer & Editor');
      annotation.setSubject(TABLE_SUBJECT);
      annotation.setContents(JSON.stringify({
        type: 'table',
        rows: rowCount,
        columns: columnCount,
        color,
        borderWidth,
        rect: normalizedRect
      }));
      annotation.update();
      page.update();
    } finally {
      annotation.destroy();
    }
  }

  appendRawContent(page, commands) {
    const pageObject = page.getObject();
    try {
      const stream = this.pdfDocument.addStream(String(commands || ''));
      let contents = pageObject.get('Contents');
      if (contents.isArray()) {
        contents.push(stream);
      } else {
        const contentsArray = this.pdfDocument.newArray();
        if (!contents.isNull()) {
          contentsArray.push(contents);
        }
        contentsArray.push(stream);
        pageObject.put('Contents', contentsArray);
        contentsArray.destroy();
      }
      stream.destroy();
      contents.destroy();
      page.update();
    } finally {
      pageObject.destroy();
    }
  }

  extendPageToFit(page, maximumBottom) {
    const bounds = page.getBounds();
    if (maximumBottom <= bounds[3] - 18) {
      return false;
    }

    const extendedBounds = [
      bounds[0],
      bounds[1],
      bounds[2],
      Math.ceil(maximumBottom + 24)
    ];
    page.setPageBox('MediaBox', extendedBounds);
    page.setPageBox('CropBox', extendedBounds);
    page.update();
    return true;
  }

  appendStaticText(page, entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const pageObject = page.getObject();
    try {
      let resources = pageObject.getInheritable('Resources');
      if (resources.isNull()) {
        resources.destroy();
        resources = this.pdfDocument.newDictionary();
        pageObject.put('Resources', resources);
      }

      let fonts = resources.get('Font');
      if (fonts.isNull()) {
        fonts.destroy();
        fonts = this.pdfDocument.newDictionary();
        resources.put('Font', fonts);
      }

      const fontEntries = new Map();
      const fontToken = Date.now().toString(36);
      const getFontEntry = (fontName) => {
        if (!fontEntries.has(fontName)) {
          const font = new mupdf.Font(fontName);
          const reference = this.pdfDocument.addFont(font);
          const resourceName = `FPVE${fontToken}${fontEntries.size}`;
          fonts.put(resourceName, reference);
          fontEntries.set(fontName, { font, reference, resourceName });
        }
        return fontEntries.get(fontName);
      };

      const transform = page.getTransform();
      const commands = ['q'];
      try {
        for (const entry of entries) {
          const text = String(entry.text || '');
          if (!text) {
            continue;
          }
          const fontName = selectWritingFont(text, entry.fontName);
          const fontEntry = getFontEntry(fontName);
          const encoded = encodePdfGlyphHex(fontEntry.font, text);
          const color = normalizeColor(entry.color, [0, 0, 0]);
          const matrix = textMatrixForPage(transform, entry.baseline);
          commands.push(
            `${formatNumber(color[0])} ${formatNumber(color[1])} ${formatNumber(color[2])} rg`,
            'BT',
            `/${fontEntry.resourceName} ${formatNumber(entry.fontSize)} Tf`,
            `${matrix.map(formatNumber).join(' ')} Tm`,
            `<${encoded.hex}> Tj`,
            'ET'
          );
        }
        commands.push('Q');
      } finally {
        for (const entry of fontEntries.values()) {
          entry.reference.destroy();
          entry.font.destroy();
        }
      }

      const stream = this.pdfDocument.addStream(commands.join('\n'));
      let contents = pageObject.get('Contents');
      if (contents.isArray()) {
        contents.push(stream);
      } else {
        const contentsArray = this.pdfDocument.newArray();
        if (!contents.isNull()) {
          contentsArray.push(contents);
        }
        contentsArray.push(stream);
        pageObject.put('Contents', contentsArray);
        contentsArray.destroy();
      }

      stream.destroy();
      contents.destroy();
      fonts.destroy();
      resources.destroy();
      page.update();
    } finally {
      pageObject.destroy();
    }
  }

  createFreeText(page, rect, properties) {
    const annotation = page.createAnnotation('FreeText');
    try {
      annotation.setRect(normalizeRect(rect));
      annotation.setContents(String(properties.text || ''));
      annotation.setDefaultAppearance(
        normalizePdfFont(properties.font),
        Number(properties.fontSize || 12),
        normalizeColor(properties.color, [0, 0, 0])
      );
      annotation.setQuadding(Number(properties.alignment || 0));
      annotation.setOpacity(Number(properties.opacity ?? 1));
      annotation.setBorderWidth(Number(properties.borderWidth || 0));
      annotation.setAuthor(String(properties.author || 'PDF Viewer & Editor'));
      annotation.update();
      page.update();
    } finally {
      annotation.destroy();
    }
  }

  addImage(pageIndex, rect, imageBytes) {
    this.withOperation('Add image', () => {
      this.withPage(pageIndex, (page) => this.createImageStamp(page, rect, imageBytes));
    });
  }

  replaceExistingImage(pageIndex, sourceRect, targetRect, imageBytes) {
    this.withOperation('Replace image', () => {
      this.withPage(pageIndex, (page) => {
        this.removeContentInRect(page, sourceRect, {
          images: true,
          lineArt: false,
          text: false
        });
        this.createImageStamp(page, targetRect, imageBytes);
      });
    });
  }

  replaceAnnotationImage(pageIndex, annotationIndex, rect, imageBytes) {
    this.withOperation('Replace image', () => {
      this.withPage(pageIndex, (page) => {
        const annotations = page.getAnnotations();
        try {
          const annotation = annotations[annotationIndex];
          if (!annotation) {
            throw new Error('The selected image annotation no longer exists.');
          }
          page.deleteAnnotation(annotation);
          this.createImageStamp(page, rect, imageBytes);
        } finally {
          destroyAll(annotations);
        }
      });
    });
  }

  createImageStamp(page, rect, imageBytes) {
    const image = new mupdf.Image(imageBytes);
    const annotation = page.createAnnotation('Stamp');
    try {
      annotation.setRect(normalizeRect(rect));
      annotation.setIntent('StampImage');
      annotation.setStampImage(image);
      annotation.setAuthor('PDF Viewer & Editor');
      annotation.update();
      page.update();
    } finally {
      annotation.destroy();
      image.destroy();
    }
  }

  getImageDimensions(imageBytes) {
    const image = new mupdf.Image(imageBytes);
    try {
      return {
        width: image.getWidth(),
        height: image.getHeight()
      };
    } finally {
      image.destroy();
    }
  }

  deleteExistingContent(pageIndex, rect, options) {
    this.withOperation('Delete PDF content', () => {
      this.withPage(pageIndex, (page) => this.removeContentInRect(page, rect, options));
    });
  }

  removeContentInRect(page, rect, options) {
    const annotation = page.createAnnotation('Redact');
    try {
      annotation.setRect(normalizeRect(rect));
      annotation.update();
      annotation.applyRedaction(
        0,
        options.images ? mupdf.PDFPage.REDACT_IMAGE_PIXELS : mupdf.PDFPage.REDACT_IMAGE_NONE,
        options.lineArt
          ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED
          : mupdf.PDFPage.REDACT_LINE_ART_NONE,
        options.text ? mupdf.PDFPage.REDACT_TEXT_REMOVE : mupdf.PDFPage.REDACT_TEXT_NONE
      );
      page.update();
    } finally {
      annotation.destroy();
    }
  }

  addShape(pageIndex, shape) {
    this.withOperation(`Add ${shape.type}`, () => {
      this.withPage(pageIndex, (page) => {
        const annotation = page.createAnnotation(shape.type);
        try {
          if (shape.type === 'Line') {
            annotation.setLine(shape.points[0], shape.points[1]);
            annotation.setLineEndingStyles(
              shape.arrow ? 'None' : 'None',
              shape.arrow ? 'ClosedArrow' : 'None'
            );
          } else if (shape.type === 'Ink') {
            annotation.setInkList(shape.strokes || []);
          } else if (shape.quads) {
            annotation.setQuadPoints(shape.quads);
          } else {
            annotation.setRect(normalizeRect(shape.rect));
          }

          annotation.setColor(normalizeColor(shape.color, [1, 0, 0]));
          if (annotation.hasInteriorColor() && shape.fillColor) {
            annotation.setInteriorColor(normalizeColor(shape.fillColor, []));
          }
          if (annotation.hasBorder()) {
            annotation.setBorderWidth(Number(shape.borderWidth || 2));
          }
          annotation.setOpacity(Number(shape.opacity ?? 1));
          annotation.setAuthor('PDF Viewer & Editor');
          annotation.update();
          page.update();
        } finally {
          annotation.destroy();
        }
      });
    });
  }

  addTextMarkup(pageIndex, type, rect) {
    const allowed = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
    if (!allowed.has(type)) {
      throw new Error(`Unsupported text markup: ${type}.`);
    }
    this.addShape(pageIndex, {
      type,
      quads: [rectToQuad(rect)],
      color: type === 'Highlight' ? [1, 0.85, 0] : [0.9, 0.1, 0.1],
      opacity: type === 'Highlight' ? 0.45 : 1
    });
  }

  addComment(pageIndex, point, text) {
    this.withOperation('Add comment', () => {
      this.withPage(pageIndex, (page) => {
        const annotation = page.createAnnotation('Text');
        try {
          annotation.setRect([point[0], point[1], point[0] + 24, point[1] + 24]);
          annotation.setContents(String(text || ''));
          annotation.setAuthor('PDF Viewer & Editor');
          annotation.setIcon('Comment');
          annotation.update();
          page.update();
        } finally {
          annotation.destroy();
        }
      });
    });
  }

  addRedaction(pageIndex, rect) {
    this.withOperation('Mark redaction', () => {
      this.withPage(pageIndex, (page) => {
        const annotation = page.createAnnotation('Redact');
        try {
          annotation.setRect(normalizeRect(rect));
          annotation.setColor([1, 0, 0]);
          if (annotation.hasInteriorColor()) {
            annotation.setInteriorColor([0, 0, 0]);
          }
          annotation.setContents('Marked for permanent redaction');
          annotation.update();
          page.update();
        } finally {
          annotation.destroy();
        }
      });
    });
  }

  applyRedactions(pageIndex = null) {
    this.withOperation('Apply redactions permanently', () => {
      const pageIndexes = pageIndex === null
        ? Array.from({ length: this.countPages() }, (_, index) => index)
        : [pageIndex];
      for (const index of pageIndexes) {
        this.withPage(index, (page) => {
          page.applyRedactions(
            false,
            mupdf.PDFPage.REDACT_IMAGE_PIXELS,
            mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
            mupdf.PDFPage.REDACT_TEXT_REMOVE
          );
          page.update();
        });
      }
    });
  }

  updateAnnotation(pageIndex, annotationIndex, properties) {
    this.withOperation('Edit annotation', () => {
      this.withPage(pageIndex, (page) => {
        const annotations = page.getAnnotations();
        try {
          const annotation = annotations[annotationIndex];
          if (!annotation) {
            throw new Error('The selected annotation no longer exists.');
          }

          if (properties.rect && annotation.hasRect()) {
            annotation.setRect(normalizeRect(properties.rect));
          }
          if (properties.text !== undefined) {
            annotation.setContents(String(properties.text));
          }
          if (properties.color) {
            annotation.setColor(normalizeColor(properties.color, [0, 0, 0]));
          }
          if (properties.fillColor && annotation.hasInteriorColor()) {
            annotation.setInteriorColor(normalizeColor(properties.fillColor, []));
          }
          if (properties.opacity !== undefined) {
            annotation.setOpacity(Number(properties.opacity));
          }
          if (properties.borderWidth !== undefined && annotation.hasBorder()) {
            annotation.setBorderWidth(Number(properties.borderWidth));
          }
          if (annotation.getType() === 'FreeText') {
            annotation.setDefaultAppearance(
              normalizePdfFont(properties.font),
              Number(properties.fontSize || 12),
              normalizeColor(properties.color, [0, 0, 0])
            );
            annotation.setQuadding(Number(properties.alignment || 0));
          }
          annotation.setModificationDate(new Date());
          annotation.update();
          page.update();
        } finally {
          destroyAll(annotations);
        }
      });
    });
  }

  updateAnnotationRect(pageIndex, annotationIndex, rect) {
    this.updateAnnotation(pageIndex, annotationIndex, { rect });
  }

  deleteAnnotation(pageIndex, annotationIndex) {
    this.withOperation('Delete annotation', () => {
      this.withPage(pageIndex, (page) => {
        const annotations = page.getAnnotations();
        try {
          const annotation = annotations[annotationIndex];
          if (!annotation) {
            throw new Error('The selected annotation no longer exists.');
          }
          page.deleteAnnotation(annotation);
          page.update();
        } finally {
          destroyAll(annotations);
        }
      });
    });
  }

  updateWidget(pageIndex, widgetIndex, value) {
    this.withOperation('Fill PDF form', () => {
      this.withPage(pageIndex, (page) => {
        const widgets = page.getWidgets();
        try {
          const widget = widgets[widgetIndex];
          if (!widget) {
            throw new Error('The selected form field no longer exists.');
          }
          if (widget.isReadOnly()) {
            throw new Error('This PDF form field is read-only.');
          }
          if (widget.isCheckbox() || widget.isRadioButton()) {
            widget.toggle();
          } else if (widget.isChoice()) {
            widget.setChoiceValue(String(value));
          } else if (widget.isText()) {
            widget.setTextValue(String(value));
          }
          widget.update();
          page.update();
        } finally {
          destroyAll(widgets);
        }
      });
    });
  }

  rotatePage(pageIndex, degrees = 90) {
    this.withOperation('Rotate page', () => {
      const pageObject = this.pdfDocument.findPage(pageIndex);
      try {
        const inheritedRotation = pageObject.getInheritable('Rotate');
        const currentRotation = inheritedRotation.isNumber()
          ? inheritedRotation.asNumber()
          : 0;
        pageObject.put('Rotate', ((currentRotation + degrees) % 360 + 360) % 360);
        inheritedRotation.destroy();
      } finally {
        pageObject.destroy();
      }
    });
  }

  cropPage(pageIndex, rect) {
    this.withOperation('Crop page', () => {
      this.withPage(pageIndex, (page) => page.setPageBox('CropBox', normalizeRect(rect)));
    });
  }

  addBlankPage(afterPageIndex) {
    this.withOperation('Add blank page', () => {
      let bounds = [0, 0, 595, 842];
      if (this.countPages() > 0) {
        this.withPage(Math.max(0, Math.min(afterPageIndex, this.countPages() - 1)), (page) => {
          bounds = [...page.getBounds('MediaBox')];
        });
      }
      const resources = this.pdfDocument.addObject(this.pdfDocument.newDictionary());
      const pageObject = this.pdfDocument.addPage(bounds, 0, resources, '');
      this.pdfDocument.insertPage(afterPageIndex + 1, pageObject);
      pageObject.destroy();
      resources.destroy();
    });
  }

  deletePage(pageIndex) {
    if (this.countPages() <= 1) {
      throw new Error('A PDF must contain at least one page.');
    }
    this.withOperation('Delete page', () => this.pdfDocument.deletePage(pageIndex));
  }

  duplicatePage(pageIndex) {
    const snapshot = this.serialize('incremental');
    this.withOperation('Duplicate page', () => {
      const sourceDocument = mupdf.Document.openDocument(snapshot, 'application/pdf');
      const sourcePdf = sourceDocument.asPDF();
      try {
        this.pdfDocument.graftPage(pageIndex + 1, sourcePdf, pageIndex);
      } finally {
        sourcePdf.destroy();
        sourceDocument.destroy();
      }
    });
  }

  reorderPage(fromIndex, toIndex) {
    const pageCount = this.countPages();
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 ||
        fromIndex >= pageCount || toIndex >= pageCount) {
      return;
    }
    this.withOperation('Reorder pages', () => {
      const order = Array.from({ length: pageCount }, (_, index) => index);
      const [moved] = order.splice(fromIndex, 1);
      order.splice(toIndex, 0, moved);
      this.pdfDocument.rearrangePages(order);
    });
  }

  mergePdf(bytes, insertAt) {
    this.withOperation('Merge PDF documents', () => {
      const sourceDocument = mupdf.Document.openDocument(bytes, 'application/pdf');
      if (!sourceDocument.isPDF()) {
        sourceDocument.destroy();
        throw new Error('The selected file is not a PDF.');
      }
      const sourcePdf = sourceDocument.asPDF();
      try {
        if (sourceDocument.needsPassword()) {
          throw new Error('Open the protected PDF separately and save an unlocked copy before merging it.');
        }
        for (let index = 0; index < sourceDocument.countPages(); index += 1) {
          this.pdfDocument.graftPage(insertAt + index, sourcePdf, index);
        }
      } finally {
        sourcePdf.destroy();
        sourceDocument.destroy();
      }
    });
  }

  exportPages(pageIndexes) {
    this.assertUnlocked();
    const destination = new mupdf.PDFDocument();
    try {
      for (const pageIndex of pageIndexes) {
        this.assertPageIndex(pageIndex);
        destination.graftPage(-1, this.pdfDocument, pageIndex);
      }
      const buffer = destination.saveToBuffer('garbage=4,compress=yes');
      try {
        return new Uint8Array(buffer.asUint8Array()).slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      destination.destroy();
    }
  }

  exportPageImage(pageIndex, format, dpi = 150) {
    this.assertPageIndex(pageIndex);
    const page = this.pdfDocument.loadPage(pageIndex);
    try {
      const scale = Math.max(0.1, Number(dpi) / 72);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );
      try {
        if (format === 'jpeg') {
          return new Uint8Array(pixmap.asJPEG(90)).slice();
        }
        return new Uint8Array(pixmap.asPNG()).slice();
      } finally {
        pixmap.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  flattenAnnotations() {
    this.withOperation('Flatten annotations', () => this.pdfDocument.bake(true, false));
  }

  getMetadata() {
    this.assertLoaded();
    const keys = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'];
    return Object.fromEntries(keys.map((key) => [
      key.toLowerCase(),
      safeCall(() => this.document.getMetaData(`info:${key}`), '') || ''
    ]));
  }

  setMetadata(metadata) {
    this.withOperation('Edit document properties', () => {
      for (const [key, value] of Object.entries(metadata)) {
        const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
        this.document.setMetaData(`info:${normalizedKey}`, String(value || ''));
      }
    });
  }

  getOutline() {
    this.assertLoaded();
    return safeCall(() => this.document.loadOutline(), []) || [];
  }

  listAttachments() {
    this.assertUnlocked();
    const files = this.pdfDocument.getEmbeddedFiles();
    return Object.entries(files).map(([name, reference]) => {
      try {
        const params = this.pdfDocument.getFilespecParams(reference);
        return {
          name,
          mimeType: params.mimetype || 'application/octet-stream'
        };
      } finally {
        reference.destroy();
      }
    });
  }

  addAttachment(name, mimeType, bytes) {
    this.withOperation('Add embedded file', () => {
      const now = new Date();
      const fileSpecification = this.pdfDocument.addEmbeddedFile(
        String(name),
        String(mimeType || 'application/octet-stream'),
        bytes,
        now,
        now,
        true
      );
      try {
        this.pdfDocument.insertEmbeddedFile(String(name), fileSpecification);
      } finally {
        fileSpecification.destroy();
      }
    });
  }

  extractAttachment(name) {
    this.assertUnlocked();
    const files = this.pdfDocument.getEmbeddedFiles();
    try {
      const reference = files[name];
      if (!reference) {
        throw new Error(`Embedded file not found: ${name}.`);
      }
      const buffer = this.pdfDocument.getEmbeddedFileContents(reference);
      if (!buffer) {
        throw new Error(`Could not read embedded file: ${name}.`);
      }
      try {
        return new Uint8Array(buffer.asUint8Array()).slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      destroyAll(Object.values(files));
    }
  }

  deleteAttachment(name) {
    this.withOperation('Delete embedded file', () => this.pdfDocument.deleteEmbeddedFile(name));
  }

  addOcrTextLayer(pageIndex, words, language = '') {
    if (!Array.isArray(words) || words.length === 0) {
      return;
    }
    this.withOperation('Add OCR text layer', () => {
      const page = this.pdfDocument.loadPage(pageIndex);
      try {
        const pageObject = page.getObject();
        try {
          let resources = pageObject.getInheritable('Resources');
          if (resources.isNull()) {
            resources.destroy();
            resources = this.pdfDocument.newDictionary();
            pageObject.put('Resources', resources);
          }

          let fonts = resources.get('Font');
          if (fonts.isNull()) {
            fonts.destroy();
            fonts = this.pdfDocument.newDictionary();
            resources.put('Font', fonts);
          }

          const fontEntries = new Map();
          const fontToken = Date.now().toString(36);
          const getFontEntry = (fontName) => {
            if (!fontEntries.has(fontName)) {
              const font = new mupdf.Font(fontName);
              const reference = this.pdfDocument.addFont(font);
              const resourceName = `FOCR${fontToken}${fontEntries.size}`;
              fonts.put(resourceName, reference);
              fontEntries.set(fontName, { font, reference, resourceName });
            }
            return fontEntries.get(fontName);
          };

          const transform = page.getTransform();
          const commands = ['q', 'BT', '3 Tr'];
          try {
            for (const word of words) {
              const text = String(word.text || '').trim();
              if (!text) {
                continue;
              }
              const fontEntry = getFontEntry(selectOcrFont(text, language));
              const encoded = encodePdfGlyphHex(fontEntry.font, text);
              const rect = normalizeRect(word.rect);
              const baseline = transformPoint(transform, [rect[0], rect[3]]);
              const fontSize = Math.max(4, rect[3] - rect[1]);
              const estimatedWidth = Math.max(fontSize * 0.25, encoded.advance * fontSize);
              const targetWidth = Math.max(1, rect[2] - rect[0]);
              const horizontalScale = Math.max(10, Math.min(400, (targetWidth / estimatedWidth) * 100));
              commands.push(
                `/${fontEntry.resourceName} ${formatNumber(fontSize)} Tf`,
                `${formatNumber(horizontalScale)} Tz`,
                `1 0 0 1 ${formatNumber(baseline[0])} ${formatNumber(baseline[1])} Tm`,
                `<${encoded.hex}> Tj`
              );
            }
            commands.push('ET', 'Q');
          } finally {
            for (const entry of fontEntries.values()) {
              entry.reference.destroy();
              entry.font.destroy();
            }
          }

          const stream = this.pdfDocument.addStream(commands.join('\n'));
          let contents = pageObject.get('Contents');
          if (contents.isArray()) {
            contents.push(stream);
          } else {
            const contentsArray = this.pdfDocument.newArray();
            if (!contents.isNull()) {
              contentsArray.push(contents);
            }
            contentsArray.push(stream);
            pageObject.put('Contents', contentsArray);
            contentsArray.destroy();
          }

          stream.destroy();
          contents.destroy();
          fonts.destroy();
          resources.destroy();
        } finally {
          pageObject.destroy();
        }
      } finally {
        page.destroy();
      }
    });
  }

  serialize(mode = 'incremental') {
    this.assertUnlocked();
    const options = mode === 'clean'
      ? 'garbage=4,compress=yes,compress-images=yes,compress-fonts=yes'
      : (this.pdfDocument.canBeSavedIncrementally() ? 'incremental' : 'compress=yes');
    const buffer = this.pdfDocument.saveToBuffer(options);
    try {
      return new Uint8Array(buffer.asUint8Array()).slice();
    } finally {
      buffer.destroy();
    }
  }

  withOperation(label, callback) {
    this.assertUnlocked();
    this.pdfDocument.beginOperation(label);
    try {
      callback();
      this.pdfDocument.endOperation();
    } catch (error) {
      this.pdfDocument.abandonOperation();
      throw error;
    }
  }

  withPage(pageIndex, callback) {
    this.assertPageIndex(pageIndex);
    const page = this.pdfDocument.loadPage(pageIndex);
    try {
      return callback(page);
    } finally {
      page.destroy();
    }
  }

  assertLoaded() {
    if (!this.document || !this.pdfDocument) {
      throw new Error('No PDF document is loaded.');
    }
  }

  assertUnlocked() {
    this.assertLoaded();
    if (this.document.needsPassword() && !this.passwordAccepted) {
      throw new Error('The PDF is password protected.');
    }
  }

  assertPageIndex(pageIndex) {
    this.assertUnlocked();
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.countPages()) {
      throw new Error(`Invalid PDF page index: ${pageIndex}.`);
    }
  }
}

function extractTextBlocks(structuredText) {
  const blocks = [];
  let currentBlock = null;
  let currentLine = null;

  structuredText.walk({
    beginTextBlock(bbox) {
      currentBlock = {
        sourceRect: normalizeRect([...bbox]),
        lines: []
      };
    },
    beginLine(bbox) {
      currentLine = {
        text: '',
        rect: normalizeRect([...bbox]),
        baseline: null,
        styles: new Map(),
        characters: []
      };
    },
    onChar(character, origin, font, size, quad, color) {
      if (!currentLine) {
        font.destroy();
        return;
      }
      try {
        const fontInfo = {
          name: safeCall(() => font.getName(), 'Helvetica'),
          family: safeCall(() => font.isMono(), false)
            ? 'monospace'
            : (safeCall(() => font.isSerif(), false) ? 'serif' : 'sans-serif'),
          weight: safeCall(() => font.isBold(), false) ? 'bold' : 'normal',
          style: safeCall(() => font.isItalic(), false) ? 'italic' : 'normal',
          size: Number(size || 12),
          editableFamily: safeCall(() => font.isMono(), false)
            ? 'Courier'
            : (safeCall(() => font.isSerif(), false) ? 'Times-Roman' : 'Helvetica'),
          bold: safeCall(() => font.isBold(), false),
          italic: safeCall(() => font.isItalic(), false)
        };
        const normalizedColor = normalizeColor([...color], [0, 0, 0]);
        const styleKey = JSON.stringify([fontInfo, normalizedColor]);
        const weightedStyle = currentLine.styles.get(styleKey) || {
          font: fontInfo,
          color: normalizedColor,
          weight: 0
        };
        weightedStyle.weight += Math.max(1, String(character).trim().length);
        currentLine.styles.set(styleKey, weightedStyle);
        const characterText = String(character);
        const characterRect = quadToRect(quad);
        currentLine.text += characterText;
        currentLine.characters.push({ text: characterText, rect: characterRect });
        currentLine.baseline ||= [Number(origin[0] || 0), Number(origin[1] || 0)];
        currentLine.rect = unionRects([
          currentLine.rect,
          characterRect
        ]);
      } finally {
        font.destroy();
      }
    },
    endLine() {
      if (!currentBlock || !currentLine) {
        currentLine = null;
        return;
      }
      const style = dominantWeightedStyle(currentLine.styles);
      currentBlock.lines.push({
        text: currentLine.text,
        rect: currentLine.rect,
        baseline: currentLine.baseline || [currentLine.rect[0], currentLine.rect[3]],
        font: style.font,
        color: style.color,
        characters: currentLine.characters
      });
      currentLine = null;
    },
    endTextBlock() {
      if (!currentBlock) {
        return;
      }
      const lines = currentBlock.lines.filter((line) => line.text.length > 0);
      if (lines.length > 0) {
        const visualLines = buildVisualLines(lines);
        for (const paragraphLines of splitVisualLinesIntoParagraphs(visualLines)) {
          const paragraphFragments = paragraphLines.flatMap((line) => line.fragments);
          const rect = unionRects(paragraphLines.map((line) => line.rect));
          const blockStyle = dominantLineStyle(paragraphFragments);
          const index = blocks.length;
          const decoratedLines = decorateParagraphLines(paragraphLines, index);
          blocks.push({
            index,
            rect,
            text: decoratedLines.text,
            lines: paragraphFragments.map((line, lineIndex) => ({
              ...line,
              blockIndex: index,
              lineIndex
            })),
            visualLines: decoratedLines.lines,
            font: blockStyle.font,
            color: blockStyle.color,
            alignment: inferTextAlignment(rect, paragraphLines),
            metrics: metricsForBlock(rect, paragraphLines, blockStyle.font.size)
          });
        }
      }
      currentBlock = null;
    }
  });

  return blocks;
}

function dominantWeightedStyle(styles) {
  const fallback = {
    font: {
      name: 'Helvetica',
      family: 'sans-serif',
      weight: 'normal',
      style: 'normal',
      size: 12,
      editableFamily: 'Helvetica',
      bold: false,
      italic: false
    },
    color: [0, 0, 0],
    weight: 1
  };
  return [...styles.values()].reduce(
    (best, candidate) => candidate.weight > best.weight ? candidate : best,
    fallback
  );
}

function dominantLineStyle(lines) {
  const styles = new Map();
  for (const line of lines) {
    const key = JSON.stringify([line.font, line.color]);
    const value = styles.get(key) || {
      font: line.font,
      color: line.color,
      weight: 0
    };
    value.weight += Math.max(1, line.text.trim().length);
    styles.set(key, value);
  }
  return dominantWeightedStyle(styles);
}

function buildVisualLines(lines) {
  const sortedLines = [...lines].sort((left, right) => {
    const yDifference = left.baseline[1] - right.baseline[1];
    return Math.abs(yDifference) > 0.75
      ? yDifference
      : left.rect[0] - right.rect[0];
  });
  const rows = [];
  for (const line of sortedLines) {
    const tolerance = Math.max(1, line.font.size * 0.2);
    const row = rows.findLast((candidate) =>
      Math.abs(candidate.baseline[1] - line.baseline[1]) <= tolerance
    );
    if (row) {
      row.fragments.push(line);
      row.rect = unionRects([row.rect, line.rect]);
    } else {
      rows.push({
        fragments: [line],
        rect: [...line.rect],
        baseline: [...line.baseline]
      });
    }
  }

  return rows.map((row) => {
    row.fragments.sort((left, right) => left.rect[0] - right.rect[0]);
    let text = '';
    const characters = [];
    let previous = null;
    for (const fragment of row.fragments) {
      if (previous && needsVisualSpace(previous, fragment)) {
        text += ' ';
        characters.push({
          text: ' ',
          rect: [
            previous.rect[2],
            Math.min(previous.rect[1], fragment.rect[1]),
            fragment.rect[0],
            Math.max(previous.rect[3], fragment.rect[3])
          ]
        });
      }
      text += fragment.text;
      characters.push(...(fragment.characters || []));
      previous = fragment;
    }
    const style = dominantLineStyle(row.fragments);
    return {
      text,
      characters,
      fragments: row.fragments,
      rect: row.rect,
      baseline: [row.fragments[0].baseline[0], row.baseline[1]],
      font: style.font,
      color: style.color
    };
  });
}

function needsVisualSpace(left, right) {
  if (/\s$/u.test(left.text) || /^\s/u.test(right.text)) {
    return false;
  }
  const gap = right.rect[0] - left.rect[2];
  return gap > Math.max(0.75, Math.min(left.font.size, right.font.size) * 0.12);
}

function inferTextAlignment(rect, visualLines) {
  if (visualLines.length < 2) {
    return 0;
  }
  const leftSpread = Math.max(...visualLines.map((line) => Math.abs(line.rect[0] - rect[0])));
  const rightSpread = Math.max(...visualLines.map((line) => Math.abs(line.rect[2] - rect[2])));
  const center = (rect[0] + rect[2]) / 2;
  const centerSpread = Math.max(...visualLines.map((line) =>
    Math.abs((line.rect[0] + line.rect[2]) / 2 - center)
  ));
  if (centerSpread < leftSpread * 0.65 && centerSpread < rightSpread * 0.65) {
    return 1;
  }
  if (rightSpread < leftSpread * 0.65) {
    return 2;
  }
  return 0;
}

function metricsForBlock(rect, visualLines, fontSize) {
  if (visualLines.length === 0) {
    return defaultTextMetrics(fontSize);
  }
  const firstBaseline = visualLines[0].baseline[1];
  const lastBaseline = visualLines.at(-1).baseline[1];
  const baselineOffset = Math.max(1, firstBaseline - rect[1]);
  const lineHeight = visualLines.length > 1
    ? Math.max(1, (lastBaseline - firstBaseline) / (visualLines.length - 1))
    : Math.max(fontSize * 1.2, visualLines[0].rect[3] - visualLines[0].rect[1]);
  const descent = Math.max(1, rect[3] - lastBaseline);
  const size = Math.max(1, Number(fontSize || 12));
  return {
    baselineOffset,
    lineHeight,
    descent,
    baselineOffsetRatio: baselineOffset / size,
    lineHeightRatio: lineHeight / size,
    descentRatio: descent / size
  };
}

function defaultTextMetrics(fontSize) {
  const size = Math.max(1, Number(fontSize || 12));
  return {
    baselineOffset: size * 1.05,
    lineHeight: size * 1.25,
    descent: size * 0.25,
    baselineOffsetRatio: 1.05,
    lineHeightRatio: 1.25,
    descentRatio: 0.25
  };
}

function normalizeBlockProperties(block, properties) {
  const originalFont = block.font || {};
  const requestedFamily = properties.fontFamily || properties.font || originalFont.editableFamily;
  const fontFamily = normalizeEditableFontFamily(requestedFamily);
  const bold = properties.bold === undefined
    ? Boolean(originalFont.bold)
    : Boolean(properties.bold);
  const italic = properties.italic === undefined
    ? Boolean(originalFont.italic)
    : Boolean(properties.italic);
  const fontSize = Math.max(4, Math.min(144, Number(
    properties.fontSize ?? originalFont.size ?? 12
  )));
  return {
    text: String(properties.text ?? block.text ?? '').replaceAll('\0', ''),
    fontFamily,
    fontName: resolveBase14Font(fontFamily, bold, italic),
    fontSize,
    bold,
    italic,
    color: normalizeColor(properties.color || block.color, [0, 0, 0]),
    alignment: Math.max(0, Math.min(2, Number(
      properties.alignment ?? block.alignment ?? 0
    )))
  };
}

function normalizeEditableFontFamily(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('times') || normalized.includes('serif') || normalized === 'tiro') {
    return 'Times-Roman';
  }
  if (normalized.includes('courier') || normalized.includes('mono') || normalized === 'cour') {
    return 'Courier';
  }
  return 'Helvetica';
}

function resolveBase14Font(family, bold, italic) {
  if (family === 'Times-Roman') {
    if (bold && italic) {
      return 'Times-BoldItalic';
    }
    if (bold) {
      return 'Times-Bold';
    }
    if (italic) {
      return 'Times-Italic';
    }
    return 'Times-Roman';
  }
  if (family === 'Courier') {
    if (bold && italic) {
      return 'Courier-BoldOblique';
    }
    if (bold) {
      return 'Courier-Bold';
    }
    if (italic) {
      return 'Courier-Oblique';
    }
    return 'Courier';
  }
  if (bold && italic) {
    return 'Helvetica-BoldOblique';
  }
  if (bold) {
    return 'Helvetica-Bold';
  }
  if (italic) {
    return 'Helvetica-Oblique';
  }
  return 'Helvetica';
}


function splitVisualLinesIntoParagraphs(visualLines) {
  if (!Array.isArray(visualLines) || visualLines.length === 0) {
    return [];
  }
  if (visualLines.length === 1) {
    return [[visualLines[0]]];
  }

  const lines = [...visualLines].sort((left, right) => {
    const yDifference = left.baseline[1] - right.baseline[1];
    return Math.abs(yDifference) > 0.75
      ? yDifference
      : left.rect[0] - right.rect[0];
  });
  const paragraphs = [];
  let paragraph = [lines[0]];

  for (const line of lines.slice(1)) {
    const previous = paragraph.at(-1);
    const previousHeight = Math.max(1, previous.rect[3] - previous.rect[1]);
    const currentHeight = Math.max(1, line.rect[3] - line.rect[1]);
    const fontSize = Math.max(
      1,
      Number(previous.font?.size || 0),
      Number(line.font?.size || 0)
    );
    const verticalGap = line.rect[1] - previous.rect[3];
    const baselineGap = line.baseline[1] - previous.baseline[1];
    const expectedLineHeight = Math.max(previousHeight, currentHeight, fontSize * 1.05);
    const paragraphGap = Math.max(3, fontSize * 0.55);
    const startsNewParagraph =
      verticalGap > paragraphGap ||
      baselineGap > expectedLineHeight * 1.75;

    if (startsNewParagraph) {
      paragraphs.push(paragraph);
      paragraph = [line];
    } else {
      paragraph.push(line);
    }
  }

  paragraphs.push(paragraph);
  return paragraphs;
}

function decorateParagraphLines(paragraphLines, blockIndex) {
  let text = '';
  const lines = [];

  for (const sourceLine of paragraphLines) {
    const lineText = String(sourceLine.text || '').trim();
    if (!lineText) {
      continue;
    }
    const separator = text ? ' ' : '';
    const start = text.length + separator.length;
    text += separator + lineText;
    const end = text.length;
    const lineIndex = lines.length;
    lines.push({
      ...sourceLine,
      text: lineText,
      blockIndex,
      lineIndex,
      start,
      end,
      startOffset: start,
      endOffset: end,
      textStart: start,
      textEnd: end
    });
  }

  return { text, lines };
}

function layoutRichTextBlock(rect, runs, metrics, alignment = 0) {
  const normalizedRuns = (Array.isArray(runs) ? runs : [])
    .map((run) => ({
      text: String(run?.text || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n'),
      values: run?.values || {}
    }))
    .filter((run) => run.text.length > 0);

  if (normalizedRuns.length === 0) {
    return { height: 0, entries: [], lines: [] };
  }

  const width = Math.max(24, rect[2] - rect[0]);
  const fonts = new Map();
  const getFont = (fontName) => {
    const name = String(fontName || 'Helvetica');
    if (!fonts.has(name)) {
      fonts.set(name, new mupdf.Font(name));
    }
    return fonts.get(name);
  };
  const itemWidth = (item) => measureText(
    getFont(item.values.fontName),
    item.character,
    Math.max(4, Number(item.values.fontSize || 12))
  );
  const lineWidth = (items) => items.reduce((sum, item) => sum + itemWidth(item), 0);
  const trimLine = (items) => {
    let start = 0;
    let end = items.length;
    while (start < end && /\s/u.test(items[start].character)) {
      start += 1;
    }
    while (end > start && /\s/u.test(items[end - 1].character)) {
      end -= 1;
    }
    return items.slice(start, end);
  };

  try {
    const items = [];
    for (const run of normalizedRuns) {
      for (const character of run.text) {
        items.push({ character, values: run.values });
      }
    }

    const wrappedLines = [];
    let current = [];
    let currentWidth = 0;

    const commitLine = (lineItems) => {
      wrappedLines.push(trimLine(lineItems));
    };

    for (const item of items) {
      if (item.character === '\n') {
        commitLine(current);
        current = [];
        currentWidth = 0;
        continue;
      }

      const widthToAdd = itemWidth(item);
      if (current.length > 0 && currentWidth + widthToAdd > width + 0.5) {
        let breakAt = -1;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (/\s/u.test(current[index].character)) {
            breakAt = index;
            break;
          }
        }

        if (breakAt >= 0) {
          const carry = current.slice(breakAt + 1);
          commitLine(current.slice(0, breakAt));
          current = carry;
          currentWidth = lineWidth(current);
        } else {
          commitLine(current);
          current = [];
          currentWidth = 0;
        }
      }

      if (/\s/u.test(item.character) && current.length === 0) {
        continue;
      }
      current.push(item);
      currentWidth += widthToAdd;
    }
    commitLine(current);

    const maximumFontSize = Math.max(
      4,
      ...normalizedRuns.map((run) => Math.max(4, Number(run.values.fontSize || 12)))
    );
    const baselineOffset = clampNumber(
      Number(metrics?.baselineOffsetRatio || 1.05) * maximumFontSize,
      maximumFontSize * 0.75,
      maximumFontSize * 1.5
    );
    const lineHeight = clampNumber(
      Number(metrics?.lineHeightRatio || 1.25) * maximumFontSize,
      maximumFontSize,
      maximumFontSize * 2
    );
    const descent = clampNumber(
      Number(metrics?.descentRatio || 0.25) * maximumFontSize,
      maximumFontSize * 0.12,
      maximumFontSize * 0.6
    );
    const height = baselineOffset + Math.max(0, wrappedLines.length - 1) * lineHeight + descent;
    const entries = [];

    wrappedLines.forEach((lineItems, lineIndex) => {
      const measuredWidth = lineWidth(lineItems);
      let x = rect[0];
      if (alignment === 1) {
        x = rect[0] + (width - measuredWidth) / 2;
      } else if (alignment === 2) {
        x = rect[2] - measuredWidth;
      }
      const baselineY = rect[1] + baselineOffset + lineIndex * lineHeight;
      let segment = [];
      let segmentKey = null;

      const flushSegment = () => {
        if (segment.length === 0) {
          return;
        }
        const values = segment[0].values;
        const text = segment.map((entry) => entry.character).join('');
        if (text) {
          entries.push({
            text,
            baseline: [x, baselineY],
            fontName: values.fontName || 'Helvetica',
            fontSize: Math.max(4, Number(values.fontSize || 12)),
            color: normalizeColor(values.color, [0, 0, 0])
          });
          x += measureText(
            getFont(values.fontName),
            text,
            Math.max(4, Number(values.fontSize || 12))
          );
        }
        segment = [];
        segmentKey = null;
      };

      for (const entry of lineItems) {
        const values = entry.values;
        const key = JSON.stringify([
          values.fontName || 'Helvetica',
          Math.max(4, Number(values.fontSize || 12)),
          normalizeColor(values.color, [0, 0, 0])
        ]);
        if (segmentKey !== null && key !== segmentKey) {
          flushSegment();
        }
        segmentKey = key;
        segment.push(entry);
      }
      flushSegment();
    });

    return {
      height,
      entries,
      lines: wrappedLines.map((line) => line.map((item) => item.character).join(''))
    };
  } finally {
    destroyAll(fonts.values());
  }
}

function layoutTextBlock(rect, values, metrics, originalBlock = null) {
  if (!values.text) {
    return { height: 0, entries: [], lines: [] };
  }
  const width = Math.max(24, rect[2] - rect[0]);
  const font = new mupdf.Font(values.fontName);
  let lines;
  try {
    lines = wrapText(font, values.text, values.fontSize, width);
  } finally {
    font.destroy();
  }

  const baselineOffset = clampNumber(
    Number(metrics?.baselineOffsetRatio || 1.05) * values.fontSize,
    values.fontSize * 0.75,
    values.fontSize * 1.5
  );
  const lineHeight = clampNumber(
    Number(metrics?.lineHeightRatio || 1.25) * values.fontSize,
    values.fontSize,
    values.fontSize * 2
  );
  const descent = clampNumber(
    Number(metrics?.descentRatio || 0.25) * values.fontSize,
    values.fontSize * 0.12,
    values.fontSize * 0.6
  );
  const height = baselineOffset + Math.max(0, lines.length - 1) * lineHeight + descent;
  const measureFont = new mupdf.Font(values.fontName);
  try {
    const entries = lines.flatMap((text, index) => {
      if (!text) {
        return [];
      }
      const textWidth = measureText(measureFont, text, values.fontSize);
      let x = rect[0];
      if (values.alignment === 1) {
        x = rect[0] + (width - textWidth) / 2;
      } else if (values.alignment === 2) {
        x = rect[2] - textWidth;
      }
      return [{
        text,
        baseline: [x, rect[1] + baselineOffset + index * lineHeight],
        fontName: values.fontName,
        fontSize: values.fontSize,
        color: values.color
      }];
    });
    return { height, entries, lines, originalBlock };
  } finally {
    measureFont.destroy();
  }
}

function wrapText(font, value, fontSize, maximumWidth) {
  const lines = [];
  for (const paragraph of String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    const words = paragraph.trim().split(/\s+/u);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(font, candidate, fontSize) <= maximumWidth + 0.5) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      const pieces = splitLongWord(font, word, fontSize, maximumWidth);
      lines.push(...pieces.slice(0, -1));
      line = pieces.at(-1) || '';
    }
    lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

function splitLongWord(font, word, fontSize, maximumWidth) {
  if (measureText(font, word, fontSize) <= maximumWidth + 0.5) {
    return [word];
  }
  const pieces = [];
  let piece = '';
  for (const character of word) {
    const candidate = piece + character;
    if (piece && measureText(font, candidate, fontSize) > maximumWidth + 0.5) {
      pieces.push(piece);
      piece = character;
    } else {
      piece = candidate;
    }
  }
  if (piece) {
    pieces.push(piece);
  }
  return pieces.length > 0 ? pieces : [word];
}

function measureText(font, value, fontSize) {
  return encodePdfGlyphHex(font, value).advance * fontSize;
}

function findFollowingBlocks(blocks, anchorRect, excludedIndex) {
  return blocks.filter((block) =>
    block.index !== excludedIndex &&
    block.rect[1] >= anchorRect[3] - 1 &&
    rectanglesShareFlow(anchorRect, block.rect)
  );
}

function findBlocksAtOrBelow(blocks, anchorRect) {
  return blocks.filter((block) =>
    block.rect[3] >= anchorRect[1] - 1 &&
    rectanglesShareFlow(anchorRect, block.rect)
  );
}

function rectanglesShareFlow(left, right) {
  const overlap = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const minimumWidth = Math.max(1, Math.min(left[2] - left[0], right[2] - right[0]));
  return overlap / minimumWidth >= 0.25;
}

function textEntriesForExistingBlock(block, deltaY, deltaX = 0) {
  return block.lines.flatMap((line) => {
    if (!line.text) {
      return [];
    }
    return [{
      text: line.text,
      baseline: [line.baseline[0] + deltaX, line.baseline[1] + deltaY],
      fontName: resolveBase14Font(
        normalizeEditableFontFamily(line.font.editableFamily || line.font.family),
        Boolean(line.font.bold || line.font.weight === 'bold'),
        Boolean(line.font.italic || line.font.style === 'italic')
      ),
      fontSize: Math.max(4, Number(line.font.size || 12)),
      color: normalizeColor(line.color, [0, 0, 0])
    }];
  });
}

function expandRect(rect, amount) {
  return [rect[0] - amount, rect[1] - amount, rect[2] + amount, rect[3] + amount];
}

function selectWritingFont(text, preferredFont) {
  const unicodeFont = selectOcrFont(text, '');
  return unicodeFont === 'Helvetica' ? preferredFont : unicodeFont;
}

function parseTableMetadata(type, subject, contents) {
  if (type !== 'Ink' || subject !== TABLE_SUBJECT) {
    return null;
  }
  try {
    const value = JSON.parse(contents);
    if (value?.type !== 'table') {
      return null;
    }
    return {
      rows: Math.max(1, Math.min(30, Math.round(Number(value.rows) || 2))),
      columns: Math.max(1, Math.min(20, Math.round(Number(value.columns) || 2))),
      color: normalizeColor(value.color, [0, 0, 0]),
      borderWidth: Math.max(0.25, Math.min(8, Number(value.borderWidth || 1))),
      rect: Array.isArray(value.rect) && value.rect.length === 4
        ? normalizeRect(value.rect.map(Number))
        : null
    };
  } catch {
    return null;
  }
}

function textMatrixForPage(transform, baseline) {
  const point = transformPoint(transform, baseline);
  return [
    transform[0],
    transform[1],
    -transform[2],
    -transform[3],
    point[0],
    point[1]
  ];
}

function clampNumber(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function normalizePdfFont(value) {
  return ['Helv', 'TiRo', 'Cour'].includes(value) ? value : 'Helv';
}

function normalizeColor(value, fallback) {
  if (!Array.isArray(value) || ![0, 1, 3, 4].includes(value.length)) {
    return fallback;
  }
  return value.map((component) => Math.max(0, Math.min(1, Number(component))));
}

function unionRects(rects) {
  if (rects.length === 0) {
    return [0, 0, 0, 0];
  }
  return [
    Math.min(...rects.map((rect) => rect[0])),
    Math.min(...rects.map((rect) => rect[1])),
    Math.max(...rects.map((rect) => rect[2])),
    Math.max(...rects.map((rect) => rect[3]))
  ];
}

function safeCall(callback, fallback) {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function destroyAll(objects) {
  for (const object of objects) {
    try {
      object?.destroy();
    } catch {
      // Ignore cleanup failures for invalidated MuPDF handles.
    }
  }
}

function formatNumber(value) {
  return Number(value).toFixed(4).replace(/\.?0+$/, '');
}

function selectOcrFont(text, language) {
  if (/[\uAC00-\uD7AF]/u.test(text)) {
    return 'ko';
  }
  if (/[\u3040-\u30FF]/u.test(text)) {
    return 'ja';
  }
  if (/[\u3400-\u9FFF\uF900-\uFAFF]/u.test(text)) {
    const normalizedLanguage = String(language || '').toLowerCase();
    if (normalizedLanguage.includes('jpn') || normalizedLanguage === 'ja') {
      return 'ja';
    }
    if (normalizedLanguage.includes('chi_tra') || normalizedLanguage.includes('zh-hant')) {
      return 'zh-Hant';
    }
    return 'zh-Hans';
  }
  return 'Helvetica';
}

function encodePdfGlyphHex(font, value) {
  let hex = '';
  let advance = 0;
  const replacementGlyph = font.encodeCharacter('?');
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0) || 32;
    const encodedGlyph = font.encodeCharacter(codePoint);
    const glyph = encodedGlyph === 0 && codePoint !== 0 ? replacementGlyph : encodedGlyph;
    hex += glyph.toString(16).padStart(4, '0').slice(-4);
    advance += Math.max(0, font.advanceGlyph(glyph));
  }
  return { hex: hex.toUpperCase(), advance };
}
