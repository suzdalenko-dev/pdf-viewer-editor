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
  const mainUri = `${mediaUri}/webview/main.js`;
  const nonce = crypto.randomBytes(18).toString('base64');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource} blob: data:;"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>PDF Viewer</title>
</head>
<body>
  <div id="app" class="app" aria-busy="true">
    <header class="topbar" aria-label="Navegación del PDF">
      <div class="toolbar-group">
        <button id="toggle-pages" class="icon-button" title="Mostrar u ocultar páginas" aria-label="Mostrar u ocultar páginas">☰</button>
        <button id="previous-page" class="icon-button" title="Página anterior" aria-label="Página anterior">‹</button>
        <label class="page-number-label">
          <span class="sr-only">Página actual</span>
          <input id="page-number" type="number" min="1" value="1">
          <span id="page-count">/ 0</span>
        </label>
        <button id="next-page" class="icon-button" title="Página siguiente" aria-label="Página siguiente">›</button>
      </div>

      <div class="toolbar-group">
        <button id="zoom-out" class="icon-button" title="Alejar" aria-label="Alejar">−</button>
        <select id="zoom-select" title="Zoom" aria-label="Zoom">
          <option value="fit">Ajustar página</option>
          <option value="width">Ajustar ancho</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1" selected>100%</option>
          <option value="1.25">125%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
          <option value="3">300%</option>
        </select>
        <button id="zoom-in" class="icon-button" title="Acercar" aria-label="Acercar">＋</button>
      </div>

      <div class="toolbar-group search-group">
        <input id="search-input" type="search" placeholder="Buscar texto" aria-label="Buscar texto">
        <button id="search-button" title="Buscar siguiente resultado">Buscar</button>
      </div>

      <div class="toolbar-group toolbar-end" aria-label="Estado del visor">
        <span class="readonly-badge" title="El PDF no se puede modificar">Solo lectura</span>
        <span class="version-badge" title="Versión instalada">v0.0.8</span>
      </div>
    </header>

    <div class="workspace">
      <aside id="pages-sidebar" class="pages-sidebar">
        <div class="sidebar-title">Páginas</div>
        <div id="thumbnail-list" class="thumbnail-list"></div>
      </aside>

      <main id="page-viewport" class="page-viewport" tabindex="0">
        <div id="page-stage" class="page-stage">
          <canvas id="pdf-canvas" aria-label="Página PDF renderizada"></canvas>
          <div id="search-layer" class="search-layer" aria-hidden="true"></div>
        </div>
      </main>
    </div>

    <footer class="statusbar">
      <span id="status-message">Cargando visor…</span>
      <span id="document-info"></span>
    </footer>
  </div>

  <div id="loading-overlay" class="loading-overlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <span id="loading-message">Cargando motor PDF…</span>
  </div>

  <div id="dialog-backdrop" class="dialog-backdrop hidden">
    <dialog id="viewer-dialog">
      <form id="dialog-form">
        <h2 id="dialog-title">PDF Viewer</h2>
        <div id="dialog-content" class="dialog-content"></div>
        <div class="dialog-actions">
          <button id="dialog-cancel" type="button">Cancelar</button>
          <button id="dialog-confirm" class="primary-button" type="submit">Abrir PDF</button>
        </div>
      </form>
    </dialog>
  </div>

  <script nonce="${nonce}" type="module" src="${mainUri}"></script>
</body>
</html>`;
}

module.exports = {
  getWebviewHtml
};
