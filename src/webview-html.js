'use strict';

const crypto = require('node:crypto');

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 * @returns {string}
 */
function getWebviewHtml(webview, extensionUri) {
  const vscode = require('vscode');
  const mediaUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media'));
  const styleUri = `${mediaUri}/webview/styles.css`;
  const fabricUri = `${mediaUri}/vendor/fabric/fabric.min.js`;
  const tesseractUri = `${mediaUri}/vendor/tesseract/tesseract.min.js`;
  const mainUri = `${mediaUri}/webview/main.js`;
  const nonce = crypto.randomBytes(18).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource} blob: data: https://tessdata.projectnaptha.com https://cdn.jsdelivr.net;"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>PDF Viewer &amp; Editor</title>
</head>
<body>
  <div id="app" class="app" aria-busy="true">
    <header class="topbar" aria-label="PDF commands">
      <div class="toolbar-group">
        <button id="toggle-left" class="icon-button" title="Toggle pages" aria-label="Toggle pages">☰</button>
        <button id="previous-page" class="icon-button" title="Previous page" aria-label="Previous page">‹</button>
        <label class="page-number-label">
          <span class="sr-only">Current page</span>
          <input id="page-number" type="number" min="1" value="1">
          <span id="page-count">/ 0</span>
        </label>
        <button id="next-page" class="icon-button" title="Next page" aria-label="Next page">›</button>
      </div>

      <div class="toolbar-group">
        <button id="zoom-out" class="icon-button" title="Zoom out" aria-label="Zoom out">−</button>
        <select id="zoom-select" title="Zoom">
          <option value="fit">Fit page</option>
          <option value="width">Fit width</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1">100%</option>
          <option value="1.25" selected>125%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
          <option value="3">300%</option>
        </select>
        <button id="zoom-in" class="icon-button" title="Zoom in" aria-label="Zoom in">＋</button>
        <button id="rotate-page" class="icon-button" title="Rotate current page" aria-label="Rotate current page">↻</button>
      </div>

      <div class="toolbar-group search-group">
        <input id="search-input" type="search" placeholder="Search in PDF" aria-label="Search in PDF">
        <button id="search-button" title="Search">Search</button>
      </div>

      <div class="toolbar-group toolbar-end">
        <button id="undo-button" class="icon-button" title="Undo" aria-label="Undo">↶</button>
        <button id="redo-button" class="icon-button" title="Redo" aria-label="Redo">↷</button>
        <select id="save-mode" title="Save mode">
          <option value="incremental">Incremental</option>
          <option value="clean">Clean &amp; compressed</option>
        </select>
        <button id="save-button" class="primary-button" title="Save PDF">Save</button>
        <button id="document-menu-button" title="Document actions">Document ▾</button>
      </div>
    </header>

    <nav class="toolbox" aria-label="Editing tools">
      <button class="tool-button active" data-tool="select" title="Select, move, resize, or delete an object">Select</button>
      <button class="tool-button" data-tool="text-select" title="Select and copy text">Copy text</button>
      <button class="tool-button" data-tool="edit-text" title="Edit existing PDF text">Edit text</button>
      <button class="tool-button" data-tool="add-text" title="Add an editable text box">Add text</button>
      <button class="tool-button" data-tool="image" title="Insert or replace an image">Image</button>
      <span class="tool-separator"></span>
      <button class="tool-button" data-tool="rectangle" title="Draw a rectangle">Rectangle</button>
      <button class="tool-button" data-tool="circle" title="Draw a circle">Circle</button>
      <button class="tool-button" data-tool="line" title="Draw a line">Line</button>
      <button class="tool-button" data-tool="arrow" title="Draw an arrow">Arrow</button>
      <button class="tool-button" data-tool="freehand" title="Freehand drawing">Freehand</button>
      <span class="tool-separator"></span>
      <button class="tool-button" data-tool="highlight" title="Highlight a text line">Highlight</button>
      <button class="tool-button" data-tool="underline" title="Underline a text line">Underline</button>
      <button class="tool-button" data-tool="strikeout" title="Strike out a text line">Strikeout</button>
      <button class="tool-button" data-tool="comment" title="Add a comment">Comment</button>
      <button class="tool-button danger-tool" data-tool="redact" title="Mark an area for permanent redaction">Redact</button>
      <button class="tool-button" data-tool="crop-page" title="Crop the current page">Crop page</button>
    </nav>

    <div class="workspace">
      <aside id="left-sidebar" class="left-sidebar">
        <div class="sidebar-tabs" role="tablist">
          <button class="sidebar-tab active" data-sidebar-tab="pages" role="tab">Pages</button>
          <button class="sidebar-tab" data-sidebar-tab="search" role="tab">Search</button>
          <button class="sidebar-tab" data-sidebar-tab="outline" role="tab">Outline</button>
        </div>
        <section id="pages-panel" class="sidebar-panel active" aria-label="Pages">
          <div class="page-actions compact-actions">
            <button id="add-blank-page" title="Add blank page">＋ Blank</button>
            <button id="merge-pdf" title="Insert pages from another PDF">＋ PDF</button>
            <button id="duplicate-page" title="Duplicate current page">Duplicate</button>
            <button id="delete-page" class="danger-button" title="Delete current page">Delete</button>
          </div>
          <div id="thumbnail-list" class="thumbnail-list"></div>
        </section>
        <section id="search-panel" class="sidebar-panel" aria-label="Search results">
          <div class="compact-actions">
            <button id="highlight-search-results">Highlight all</button>
          </div>
          <div id="search-results" class="search-results empty-message">No search yet.</div>
        </section>
        <section id="outline-panel" class="sidebar-panel" aria-label="Document outline">
          <div id="outline-list" class="outline-list empty-message">No outline.</div>
        </section>
      </aside>

      <main id="page-viewport" class="page-viewport" tabindex="0">
        <div id="page-stage" class="page-stage">
          <canvas id="pdf-canvas" aria-label="Rendered PDF page"></canvas>
          <div id="text-layer" class="text-layer" aria-label="Selectable PDF text"></div>
          <canvas id="editor-canvas" aria-label="PDF editing layer"></canvas>
        </div>
      </main>

      <aside id="inspector" class="inspector" aria-label="Properties">
        <div class="inspector-header">
          <h2>Properties</h2>
          <button id="toggle-inspector" class="icon-button" title="Hide properties" aria-label="Hide properties">×</button>
        </div>
        <div id="selection-empty" class="empty-message">
          Select an annotation, text line, image, or form field to edit its properties.
        </div>
        <form id="properties-form" class="properties-form hidden">
          <input id="property-kind" type="hidden">
          <label id="property-text-row">
            Text
            <textarea id="property-text" rows="5"></textarea>
          </label>
          <div id="property-font-row" class="form-grid two-columns">
            <label>
              Font
              <select id="property-font">
                <option value="Helv">Helvetica</option>
                <option value="TiRo">Times Roman</option>
                <option value="Cour">Courier</option>
              </select>
            </label>
            <label>
              Size
              <input id="property-font-size" type="number" min="4" max="144" step="0.5" value="12">
            </label>
          </div>
          <div class="form-grid two-columns">
            <label>
              Stroke/Text
              <input id="property-color" type="color" value="#000000">
            </label>
            <label>
              Fill
              <input id="property-fill-color" type="color" value="#ffffff">
            </label>
          </div>
          <div class="form-grid two-columns">
            <label>
              Opacity
              <input id="property-opacity" type="range" min="0" max="1" step="0.05" value="1">
            </label>
            <label>
              Border
              <input id="property-border-width" type="number" min="0" max="20" step="0.5" value="1">
            </label>
          </div>
          <label id="property-alignment-row">
            Alignment
            <select id="property-alignment">
              <option value="0">Left</option>
              <option value="1">Center</option>
              <option value="2">Right</option>
            </select>
          </label>
          <label id="property-form-value-row" class="hidden">
            Form value
            <input id="property-form-value" type="text">
          </label>
          <div class="form-actions">
            <button id="apply-properties" class="primary-button" type="submit">Apply</button>
            <button id="replace-selected-image" type="button">Replace image</button>
            <button id="crop-selected-image" type="button">Crop image</button>
            <button id="delete-selection" class="danger-button" type="button">Delete</button>
          </div>
        </form>

        <section class="inspector-section">
          <h3>Page</h3>
          <div class="stacked-actions">
            <button id="move-page-up">Move page up</button>
            <button id="move-page-down">Move page down</button>
            <button id="export-page-pdf">Export page as PDF</button>
            <button id="export-page-png">Export page as PNG</button>
            <button id="export-page-jpeg">Export page as JPEG</button>
            <button id="split-pdf">Extract page range</button>
          </div>
        </section>

        <section class="inspector-section">
          <h3>OCR</h3>
          <label>
            Language
            <select id="ocr-language">
              <option value="spa">Spanish (offline)</option>
              <option value="eng">English (offline)</option>
              <option value="spa+eng">Spanish + English</option>
              <option value="custom">Other language code…</option>
            </select>
          </label>
          <button id="run-ocr-page">OCR current page</button>
          <button id="run-ocr-document">OCR full document</button>
          <progress id="ocr-progress" class="hidden" max="1" value="0"></progress>
        </section>

        <section class="inspector-section">
          <h3>Finalize</h3>
          <div class="stacked-actions">
            <button id="apply-redactions" class="danger-button">Apply redactions permanently</button>
            <button id="flatten-annotations">Flatten annotations</button>
          </div>
        </section>
      </aside>
    </div>

    <footer class="statusbar">
      <span id="status-message">Loading PDF editor…</span>
      <span id="document-info"></span>
    </footer>
  </div>

  <div id="loading-overlay" class="loading-overlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <span id="loading-message">Loading PDF engine…</span>
  </div>

  <div id="dialog-backdrop" class="dialog-backdrop hidden">
    <dialog id="editor-dialog">
      <form id="dialog-form" method="dialog">
        <h2 id="dialog-title">PDF Viewer &amp; Editor</h2>
        <div id="dialog-content"></div>
        <div class="dialog-actions">
          <button id="dialog-cancel" value="cancel" type="button">Cancel</button>
          <button id="dialog-confirm" class="primary-button" value="confirm" type="submit">Confirm</button>
        </div>
      </form>
    </dialog>
  </div>

  <div id="document-menu" class="popup-menu hidden" role="menu">
    <button data-document-action="metadata" role="menuitem">Document properties</button>
    <button data-document-action="forms" role="menuitem">List form fields</button>
    <button data-document-action="attachments" role="menuitem">Embedded files</button>
    <button data-document-action="merge" role="menuitem">Merge another PDF</button>
    <button data-document-action="split" role="menuitem">Extract page range</button>
    <button data-document-action="clean" role="menuitem">Optimize document</button>
  </div>

  <input id="image-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff" hidden>
  <input id="pdf-file-input" type="file" accept="application/pdf,.pdf" hidden>
  <input id="attachment-file-input" type="file" multiple hidden>

  <script nonce="${nonce}" src="${fabricUri}"></script>
  <script nonce="${nonce}" src="${tesseractUri}"></script>
  <script nonce="${nonce}" type="module" src="${mainUri}"></script>
</body>
</html>`;
}

module.exports = {
  getWebviewHtml
};
