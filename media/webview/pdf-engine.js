import mupdf from '../vendor/mupdf/mupdf.js';
import { quadToRect } from './utils.js';

/**
 * Read-only MuPDF facade used by the webview.
 *
 * Deliberately exposes only load, authentication, rendering, bounds, and
 * search operations. No document journal or serialization API is enabled.
 */
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
      // The PDF wrapper may already have been released.
    }
    try {
      this.document?.destroy();
    } catch {
      // Ignore repeated destruction while replacing the loaded document.
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

    return this.getDocumentInfo();
  }

  unlock(password) {
    this.assertLoaded();
    const result = this.document.authenticatePassword(password);
    if (result === 0) {
      return false;
    }
    this.passwordAccepted = true;
    return true;
  }

  getDocumentInfo() {
    this.assertUnlocked();
    return {
      passwordRequired: false,
      pageCount: this.document.countPages()
    };
  }

  countPages() {
    this.assertUnlocked();
    return this.document.countPages();
  }

  getPageBounds(pageIndex) {
    this.assertPageIndex(pageIndex);
    const page = this.document.loadPage(pageIndex);
    try {
      return [...page.getBounds()];
    } finally {
      page.destroy();
    }
  }

  renderPage(pageIndex, requestedScale, maxRenderPixels) {
    this.assertPageIndex(pageIndex);
    const page = this.document.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const widthInPoints = Math.max(1, bounds[2] - bounds[0]);
      const heightInPoints = Math.max(1, bounds[3] - bounds[1]);
      const safeScale = Math.max(0.01, Number(requestedScale) || 1);
      const pixelLimit = Math.max(1, Number(maxRenderPixels) || 24_000_000);
      const requestedPixels = widthInPoints * heightInPoints * safeScale * safeScale;
      const scale = requestedPixels > pixelLimit
        ? Math.sqrt(pixelLimit / (widthInPoints * heightInPoints))
        : safeScale;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        true,
        true
      );
      try {
        const pixelBounds = [...pixmap.getBounds()];
        return {
          width: pixmap.getWidth(),
          height: pixmap.getHeight(),
          pixels: new Uint8ClampedArray(pixmap.getPixels()).slice(),
          bounds: [...bounds],
          pixelBounds,
          pageToScreen: [scale, 0, 0, scale, -pixelBounds[0], -pixelBounds[1]],
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
    const page = this.document.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const width = Math.max(1, bounds[2] - bounds[0]);
      const scale = Math.min(0.35, Math.max(1, maximumWidth) / width);
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

  search(query) {
    this.assertUnlocked();
    const results = [];
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return results;
    }

    for (let pageIndex = 0; pageIndex < this.countPages(); pageIndex += 1) {
      const page = this.document.loadPage(pageIndex);
      try {
        const hits = page.search(normalizedQuery, 10000);
        for (const quads of hits) {
          const rects = quads.map((quad) => quadToRect(quad));
          results.push({
            pageIndex,
            rect: unionRects(rects)
          });
        }
      } finally {
        page.destroy();
      }
    }
    return results;
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
