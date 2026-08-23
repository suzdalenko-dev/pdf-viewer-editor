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
  fontSize: 12,
  color: [0, 0, 0],
  alignment: 0,
  opacity: 1
});

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
      try {
        parsed = JSON.parse(structuredText.asJSON());
      } finally {
        structuredText.destroy();
      }

      const textLines = [];
      const images = [];
      for (const block of parsed.blocks || []) {
        if (block.type === 'text') {
          for (const line of block.lines || []) {
            textLines.push({
              text: String(line.text || ''),
              rect: rectFromBbox(line.bbox || block.bbox),
              baseline: [Number(line.x || 0), Number(line.y || 0)],
              font: {
                name: String(line.font?.name || 'Helvetica'),
                family: String(line.font?.family || 'sans-serif'),
                weight: String(line.font?.weight || 'normal'),
                style: String(line.font?.style || 'normal'),
                size: Number(line.font?.size || 12)
              }
            });
          }
        } else if (block.type === 'image') {
          images.push({
            rect: rectFromBbox(block.bbox),
            width: Number(block.width || 0),
            height: Number(block.height || 0)
          });
        }
      }

      return {
        bounds: [...page.getBounds()],
        textLines,
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
        const rect = annotation.hasRect()
          ? annotation.getRect()
          : annotation.getBounds();
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
          rect: [...rect],
          contents: safeCall(() => annotation.getContents(), ''),
          author: safeCall(() => annotation.getAuthor(), ''),
          subject: safeCall(() => annotation.getSubject(), ''),
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
          annotation.setInteriorColor([0, 0, 0]);
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

  addOcrTextLayer(pageIndex, words) {
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

          const resourceName = `FOCR${Date.now().toString(36)}`;
          const font = new mupdf.Font('Helvetica');
          const fontObject = this.pdfDocument.addSimpleFont(font, 'Latin');
          font.destroy();
          fonts.put(resourceName, fontObject);

          const transform = page.getTransform();
          const commands = ['q', 'BT', '3 Tr'];
          for (const word of words) {
            const text = String(word.text || '').trim();
            if (!text) {
              continue;
            }
            const rect = normalizeRect(word.rect);
            const baseline = transformPoint(transform, [rect[0], rect[3]]);
            const fontSize = Math.max(4, rect[3] - rect[1]);
            const estimatedWidth = Math.max(fontSize * 0.25, text.length * fontSize * 0.5);
            const targetWidth = Math.max(1, rect[2] - rect[0]);
            const horizontalScale = Math.max(10, Math.min(400, (targetWidth / estimatedWidth) * 100));
            commands.push(
              `/${resourceName} ${formatNumber(fontSize)} Tf`,
              `${formatNumber(horizontalScale)} Tz`,
              `1 0 0 1 ${formatNumber(baseline[0])} ${formatNumber(baseline[1])} Tm`,
              `<${encodePdfLatinHex(text)}> Tj`
            );
          }
          commands.push('ET', 'Q');

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
          fontObject.destroy();
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

function encodePdfLatinHex(value) {
  let result = '';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0) || 32;
    const byte = codePoint <= 255 ? codePoint : 63;
    result += byte.toString(16).padStart(2, '0');
  }
  return result.toUpperCase();
}
