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
  const mainUri = `${mediaUri}/webview/main.js`;
  const nonce = crypto.randomBytes(18).toString('base64');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource} blob: data:;"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>PDF Viewer &amp; Editor</title>
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
        <button id="search-button" title="Buscar">Buscar</button>
      </div>

      <div class="toolbar-group toolbar-end">
        <button id="undo-button" class="icon-button" title="Deshacer" aria-label="Deshacer">↶</button>
        <button id="redo-button" class="icon-button" title="Rehacer" aria-label="Rehacer">↷</button>
        <button id="save-button" class="primary-button" title="Guardar PDF">Guardar</button>
      </div>
    </header>

    <nav class="editbar" aria-label="Edición del PDF">
      <button id="edit-text-tool" class="tool-button active" data-tool="edit">Editar texto</button>
      <button id="add-text-tool" class="tool-button" data-tool="add-text">Añadir texto</button>
      <button id="image-tool" class="tool-button" data-tool="image">Imagen</button>
      <button id="table-tool" class="tool-button" data-tool="table">Tabla</button>
      <button id="delete-tool" class="tool-button danger-button" disabled>Eliminar</button>
      <span id="tool-hint" class="tool-hint">Haz clic en un párrafo, selecciona texto o usa + para insertar.</span>
    </nav>

    <section id="selection-context" class="selection-context hidden" aria-label="Propiedades de la selección">
      <div id="text-context" class="context-row hidden">
        <button id="edit-content" class="primary-button">Editar contenido</button>
        <button id="copy-text">Copiar</button>
        <label>Fuente
          <select id="text-font-family">
            <option value="Helvetica">Helvetica</option>
            <option value="Times-Roman">Times</option>
            <option value="Courier">Courier</option>
          </select>
        </label>
        <label>Tamaño
          <input id="text-font-size" type="number" min="4" max="144" step="0.5" value="12">
        </label>
        <button id="text-bold" class="toggle-button" title="Negrita" aria-pressed="false"><strong>B</strong></button>
        <button id="text-italic" class="toggle-button" title="Cursiva" aria-pressed="false"><em>I</em></button>
        <label>Color <input id="text-color" type="color" value="#000000"></label>
        <label>Alinear
          <select id="text-alignment">
            <option value="0">Izquierda</option>
            <option value="1">Centro</option>
            <option value="2">Derecha</option>
          </select>
        </label>
      </div>

      <div id="table-context" class="context-row hidden">
        <strong>Tabla</strong>
        <label>Filas <input id="table-rows" type="number" min="1" max="30" value="2"></label>
        <label>Columnas <input id="table-columns" type="number" min="1" max="20" value="2"></label>
        <label>Color <input id="table-color" type="color" value="#000000"></label>
        <label>Línea <input id="table-border-width" type="number" min="0.25" max="8" step="0.25" value="1"></label>
        <button id="apply-table" class="primary-button">Actualizar tabla</button>
        <span class="context-help">Arrastra para mover; usa las esquinas para redimensionar.</span>
      </div>

      <div id="image-context" class="context-row hidden">
        <strong id="image-kind">Imagen</strong>
        <span id="image-help" class="context-help">Usa las esquinas para redimensionar y arrastra para mover.</span>
      </div>
    </section>

    <div class="workspace">
      <aside id="pages-sidebar" class="pages-sidebar">
        <div class="sidebar-title">Páginas</div>
        <div id="thumbnail-list" class="thumbnail-list"></div>
      </aside>

      <main id="page-viewport" class="page-viewport" tabindex="0">
        <div id="page-stage" class="page-stage">
          <canvas id="pdf-canvas" aria-label="Página PDF renderizada"></canvas>
          <div id="text-layer" class="text-layer" aria-label="Texto seleccionable del PDF"></div>
          <canvas id="editor-canvas" aria-label="Capa de edición del PDF"></canvas>
          <div id="insertion-layer" class="insertion-layer" aria-label="Puntos de inserción"></div>

          <div id="insert-menu" class="insert-menu hidden" role="menu" aria-label="Insertar entre párrafos">
            <span>Insertar aquí</span>
            <button id="insert-text-here" type="button">Texto</button>
            <button id="insert-image-here" type="button">Imagen</button>
            <button id="insert-table-here" type="button">Tabla</button>
          </div>

          <button id="edit-range-button" class="edit-range-button hidden" type="button">
            Editar selección
          </button>

          <div id="block-editor" class="block-editor hidden">
            <textarea id="block-editor-text" aria-label="Contenido del bloque"></textarea>
            <div class="block-editor-actions">
              <span>Ctrl+Enter para aplicar</span>
              <button id="cancel-block-edit">Cancelar</button>
              <button id="apply-block-edit" class="primary-button">Aplicar</button>
            </div>
          </div>
        </div>
      </main>
    </div>

    <footer class="statusbar">
      <span id="status-message">Cargando editor…</span>
      <span id="document-info"></span>
    </footer>
  </div>

  <div id="loading-overlay" class="loading-overlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <span id="loading-message">Cargando motor PDF…</span>
  </div>

  <div id="dialog-backdrop" class="dialog-backdrop hidden">
    <dialog id="editor-dialog">
      <form id="dialog-form">
        <h2 id="dialog-title">PDF Viewer &amp; Editor</h2>
        <div id="dialog-content" class="dialog-content"></div>
        <div class="dialog-actions">
          <button id="dialog-cancel" type="button">Cancelar</button>
          <button id="dialog-confirm" class="primary-button" type="submit">Aceptar</button>
        </div>
      </form>
    </dialog>
  </div>

  <input id="image-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff" hidden>

  <script nonce="${nonce}" src="${fabricUri}"></script>
  <script nonce="${nonce}" type="module" src="${mainUri}"></script>
</body>
</html>`;
}

module.exports = {
  getWebviewHtml
};
