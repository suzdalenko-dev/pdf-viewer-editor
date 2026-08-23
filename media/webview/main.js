import { PdfEngine } from './pdf-engine.js';
import {
  base64ToBytes,
  bytesToBase64,
  clamp,
  escapeHtml,
  fileToBytes,
  hexToPdfColor,
  normalizeRect,
  parsePageRange,
  pdfColorToHex,
  sanitizeFileStem,
  uint8ArrayToBlobUrl
} from './utils.js';

const vscode = acquireVsCodeApi();
const engine = new PdfEngine();

const state = {
  revision: 0,
  fileName: 'document.pdf',
  currentPage: 0,
  pageCount: 0,
  zoom: 1.25,
  zoomMode: 'numeric',
  tool: 'select',
  settings: {
    defaultZoom: 1.25,
    maxRenderPixels: 24000000,
    defaultSaveMode: 'incremental',
    ocrLanguageDataUrl: 'https://tessdata.projectnaptha.com/4.0.0_best_int'
  },
  render: null,
  pageModel: null,
  fabricCanvas: null,
  drawStart: null,
  drawPreview: null,
  freehandPoints: [],
  searchQuery: '',
  searchResults: [],
  selectedMeta: null,
  pendingImageAction: null,
  pendingPdfAction: null,
  password: '',
  loadToken: 0,
  thumbnailToken: 0,
  busy: false
};

const elements = Object.fromEntries([
  'app', 'loading-overlay', 'loading-message', 'status-message', 'document-info',
  'previous-page', 'next-page', 'page-number', 'page-count', 'zoom-out', 'zoom-in',
  'zoom-select', 'rotate-page', 'search-input', 'search-button', 'undo-button',
  'redo-button', 'save-mode', 'save-button', 'document-menu-button', 'document-menu',
  'toggle-left', 'left-sidebar', 'toggle-inspector', 'inspector', 'page-viewport',
  'page-stage', 'pdf-canvas', 'text-layer', 'editor-canvas', 'thumbnail-list',
  'search-results', 'highlight-search-results', 'outline-list', 'selection-empty',
  'properties-form', 'property-kind', 'property-text-row', 'property-text',
  'property-font-row', 'property-font', 'property-font-size', 'property-color',
  'property-fill-color', 'property-opacity', 'property-border-width',
  'property-alignment-row', 'property-alignment', 'property-form-value-row',
  'property-form-value', 'replace-selected-image', 'crop-selected-image',
  'delete-selection', 'add-blank-page', 'merge-pdf', 'duplicate-page', 'delete-page',
  'move-page-up', 'move-page-down', 'export-page-pdf', 'export-page-png',
  'export-page-jpeg', 'split-pdf', 'ocr-language', 'run-ocr-page',
  'run-ocr-document', 'ocr-progress', 'apply-redactions', 'flatten-annotations',
  'image-file-input', 'pdf-file-input', 'attachment-file-input', 'dialog-backdrop',
  'editor-dialog', 'dialog-form', 'dialog-title', 'dialog-content', 'dialog-cancel',
  'dialog-confirm'
].map((id) => [id, document.getElementById(id)]));

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message.type === 'load-document') {
    await loadDocument(message);
  } else if (message.type === 'operation-error') {
    setBusy(false);
    setStatus(message.message, 'error');
  }
});

initializeEventHandlers();
vscode.postMessage({ type: 'ready' });

async function loadDocument(message) {
  const token = ++state.loadToken;
  setBusy(true, 'Opening PDF…');
  try {
    state.revision = Number(message.revision || 0);
    state.fileName = String(message.fileName || 'document.pdf');
    state.settings = { ...state.settings, ...(message.settings || {}) };
    state.zoom = Number(state.settings.defaultZoom || 1.25);
    state.zoomMode = 'numeric';
    state.password = '';
    elements['save-mode'].value = state.settings.defaultSaveMode;
    syncZoomControl();

    const bytes = base64ToBytes(message.data);
    let info = engine.load(bytes);
    while (info.passwordRequired) {
      const password = await requestPassword(Boolean(info.invalidPassword));
      if (password === null) {
        throw new Error('A password is required to open this PDF.');
      }
      state.password = password;
      if (engine.unlock(password)) {
        info = engine.getDocumentInfo();
      } else {
        info = { passwordRequired: true, invalidPassword: true };
      }
    }

    if (token !== state.loadToken) {
      return;
    }

    state.pageCount = info.pageCount;
    state.currentPage = clamp(state.currentPage, 0, Math.max(0, state.pageCount - 1));
    state.searchResults = [];
    state.searchQuery = '';
    elements['search-input'].value = '';
    renderOutline(info.outline || []);
    await renderCurrentPage();
    void renderThumbnails();
    elements.app.setAttribute('aria-busy', 'false');
    setStatus('PDF ready. All processing stays on this computer.');
  } catch (error) {
    reportError(error);
  } finally {
    if (token === state.loadToken) {
      setBusy(false);
    }
  }
}

async function renderCurrentPage(options = {}) {
  if (state.pageCount === 0) {
    return;
  }
  const keepSelection = Boolean(options.keepSelection);
  const selectedMeta = keepSelection ? state.selectedMeta : null;
  setBusy(true, `Rendering page ${state.currentPage + 1}…`);
  try {
    state.pageModel = engine.getPageModel(state.currentPage);
    const scale = calculateRenderScale(state.pageModel.bounds);
    state.render = engine.renderPage(
      state.currentPage,
      scale,
      Number(state.settings.maxRenderPixels),
      true
    );
    drawRenderedPage(state.render);
    initializeOrResizeFabricCanvas(state.render.width, state.render.height);
    buildTextLayer();
    buildEditingOverlay();
    updatePageControls();
    updateDocumentInfo();
    if (selectedMeta) {
      restoreSelection(selectedMeta);
    } else {
      clearInspector();
    }
  } finally {
    setBusy(false);
  }
}

function calculateRenderScale(bounds) {
  const width = Math.max(1, bounds[2] - bounds[0]);
  const height = Math.max(1, bounds[3] - bounds[1]);
  const viewportWidth = Math.max(200, elements['page-viewport'].clientWidth - 48);
  const viewportHeight = Math.max(200, elements['page-viewport'].clientHeight - 48);
  if (state.zoomMode === 'fit') {
    return Math.min(viewportWidth / width, viewportHeight / height);
  }
  if (state.zoomMode === 'width') {
    return viewportWidth / width;
  }
  return clamp(state.zoom, 0.25, 5);
}

function drawRenderedPage(render) {
  const canvas = elements['pdf-canvas'];
  canvas.width = render.width;
  canvas.height = render.height;
  canvas.style.width = `${render.width}px`;
  canvas.style.height = `${render.height}px`;
  const context = canvas.getContext('2d', { alpha: true });
  context.putImageData(new ImageData(render.pixels, render.width, render.height), 0, 0);
  elements['page-stage'].style.width = `${render.width}px`;
  elements['page-stage'].style.height = `${render.height}px`;
}

function initializeOrResizeFabricCanvas(width, height) {
  if (!state.fabricCanvas) {
    state.fabricCanvas = new fabric.Canvas('editor-canvas', {
      width,
      height,
      preserveObjectStacking: true,
      selection: true,
      stopContextMenu: true,
      fireRightClick: true
    });
    state.fabricCanvas.on('selection:created', selectionChanged);
    state.fabricCanvas.on('selection:updated', selectionChanged);
    state.fabricCanvas.on('selection:cleared', () => {
      state.selectedMeta = null;
      clearInspector();
    });
    state.fabricCanvas.on('object:modified', objectModified);
    state.fabricCanvas.on('mouse:down', drawingMouseDown);
    state.fabricCanvas.on('mouse:move', drawingMouseMove);
    state.fabricCanvas.on('mouse:up', drawingMouseUp);
    state.fabricCanvas.on('mouse:dblclick', overlayDoubleClick);
  } else {
    state.fabricCanvas.setDimensions({ width, height });
  }
  state.fabricCanvas.clear();
}

function buildTextLayer() {
  const layer = elements['text-layer'];
  layer.replaceChildren();
  layer.style.width = `${state.render.width}px`;
  layer.style.height = `${state.render.height}px`;

  for (const line of state.pageModel.textLines) {
    const screen = pdfRectToScreen(line.rect);
    const item = document.createElement('span');
    item.className = 'text-layer-line';
    item.textContent = line.text;
    item.style.left = `${screen[0]}px`;
    item.style.top = `${screen[1]}px`;
    item.style.width = `${Math.max(1, screen[2] - screen[0])}px`;
    item.style.height = `${Math.max(1, screen[3] - screen[1])}px`;
    item.style.fontSize = `${Math.max(6, line.font.size * state.render.scale)}px`;
    item.style.fontFamily = line.font.family;
    layer.appendChild(item);
  }
  layer.classList.toggle('active', state.tool === 'text-select');
}

function buildEditingOverlay() {
  const canvas = state.fabricCanvas;
  canvas.clear();
  canvas.selection = state.tool === 'select';
  canvas.skipTargetFind = state.tool === 'text-select';
  canvas.wrapperEl?.classList.toggle('text-selection-disabled', state.tool === 'text-select');

  if (state.tool === 'select') {
    for (const annotation of state.pageModel.annotations) {
      addOverlayBox(annotation.rect, {
        kind: 'annotation',
        pageIndex: state.currentPage,
        annotationIndex: annotation.index,
        annotation
      }, '#2f80ed', true);
    }
    for (const [index, image] of state.pageModel.images.entries()) {
      addOverlayBox(image.rect, {
        kind: 'image-block',
        pageIndex: state.currentPage,
        imageIndex: index,
        rect: image.rect
      }, '#9b51e0', true);
    }
    for (const widget of state.pageModel.widgets) {
      addOverlayBox(widget.rect, {
        kind: 'widget',
        pageIndex: state.currentPage,
        widgetIndex: widget.index,
        widget
      }, '#27ae60', false);
    }
  }

  if (['edit-text', 'highlight', 'underline', 'strikeout'].includes(state.tool)) {
    for (const [index, line] of state.pageModel.textLines.entries()) {
      addOverlayBox(line.rect, {
        kind: 'text-line',
        pageIndex: state.currentPage,
        lineIndex: index,
        line
      }, state.tool === 'edit-text' ? '#f2994a' : '#f2c94c', false);
    }
  }

  for (const result of state.searchResults.filter((item) => item.pageIndex === state.currentPage)) {
    const screen = pdfRectToScreen(result.rect);
    const marker = new fabric.Rect({
      left: screen[0],
      top: screen[1],
      width: screen[2] - screen[0],
      height: screen[3] - screen[1],
      fill: 'rgba(255, 220, 0, 0.28)',
      stroke: 'rgba(255, 180, 0, 0.8)',
      strokeWidth: 1,
      selectable: false,
      evented: false
    });
    canvas.add(marker);
    canvas.sendObjectToBack(marker);
  }

  canvas.requestRenderAll();
}

function addOverlayBox(rect, meta, color, resizable) {
  const screen = pdfRectToScreen(rect);
  const box = new fabric.Rect({
    left: screen[0],
    top: screen[1],
    width: Math.max(2, screen[2] - screen[0]),
    height: Math.max(2, screen[3] - screen[1]),
    fill: 'rgba(0, 0, 0, 0.001)',
    stroke: color,
    strokeWidth: 1,
    strokeDashArray: [5, 4],
    transparentCorners: false,
    cornerColor: color,
    cornerSize: 8,
    hasRotatingPoint: false,
    lockRotation: true,
    selectable: true,
    evented: true,
    hasControls: resizable,
    hoverCursor: resizable ? 'move' : 'pointer'
  });
  box.pdfMeta = meta;
  state.fabricCanvas.add(box);
}

function pdfRectToScreen(rect) {
  const [x0, y0, x1, y1] = normalizeRect(rect);
  const bounds = state.render.bounds;
  const scale = state.render.scale;
  return [
    (x0 - bounds[0]) * scale,
    (y0 - bounds[1]) * scale,
    (x1 - bounds[0]) * scale,
    (y1 - bounds[1]) * scale
  ];
}

function screenRectToPdf(rect) {
  const bounds = state.render.bounds;
  const scale = state.render.scale;
  return normalizeRect([
    rect[0] / scale + bounds[0],
    rect[1] / scale + bounds[1],
    rect[2] / scale + bounds[0],
    rect[3] / scale + bounds[1]
  ]);
}

function selectionChanged(event) {
  const object = event.selected?.[0];
  if (!object?.pdfMeta) {
    clearInspector();
    return;
  }
  state.selectedMeta = object.pdfMeta;
  if (object.pdfMeta.kind === 'text-line' &&
      ['edit-text', 'highlight', 'underline', 'strikeout'].includes(state.tool)) {
    void handleTextLineTool(object.pdfMeta);
    return;
  }
  populateInspector(object.pdfMeta);
}

async function objectModified(event) {
  const object = event.target;
  const meta = object?.pdfMeta;
  if (!meta) {
    return;
  }
  const bounding = object.getBoundingRect();
  const targetRect = screenRectToPdf([
    bounding.left,
    bounding.top,
    bounding.left + bounding.width,
    bounding.top + bounding.height
  ]);

  try {
    if (meta.kind === 'annotation') {
      engine.updateAnnotationRect(state.currentPage, meta.annotationIndex, targetRect);
      await commitAndRefresh('Move or resize annotation');
    } else if (meta.kind === 'image-block') {
      const imageBytes = await capturePageRegionAsPng(meta.rect);
      engine.replaceExistingImage(state.currentPage, meta.rect, targetRect, imageBytes);
      await commitAndRefresh('Move or resize image');
    }
  } catch (error) {
    reportError(error);
    await renderCurrentPage();
  }
}

function overlayDoubleClick(event) {
  const meta = event.target?.pdfMeta;
  if (!meta) {
    return;
  }
  if (meta.kind === 'text-line') {
    void editTextLine(meta.line);
  } else if (meta.kind === 'annotation') {
    populateInspector(meta);
    elements['property-text']?.focus();
  } else if (meta.kind === 'widget') {
    populateInspector(meta);
    elements['property-form-value']?.focus();
  }
}

function drawingMouseDown(event) {
  if (state.busy || state.tool === 'select' || state.tool === 'text-select' ||
      ['edit-text', 'highlight', 'underline', 'strikeout'].includes(state.tool)) {
    return;
  }
  const point = getCanvasPoint(event.e);
  state.drawStart = point;
  if (state.tool === 'freehand') {
    state.freehandPoints = [point];
    state.drawPreview = new fabric.Polyline([point], {
      fill: 'transparent',
      stroke: '#e53935',
      strokeWidth: 2,
      selectable: false,
      evented: false
    });
    state.fabricCanvas.add(state.drawPreview);
  } else if (['rectangle', 'crop-page', 'redact', 'add-text'].includes(state.tool)) {
    state.drawPreview = new fabric.Rect({
      left: point.x,
      top: point.y,
      width: 1,
      height: 1,
      fill: state.tool === 'redact' ? 'rgba(0,0,0,.25)' : 'rgba(47,128,237,.08)',
      stroke: state.tool === 'redact' ? '#eb5757' : '#2f80ed',
      strokeDashArray: [6, 4],
      selectable: false,
      evented: false
    });
    state.fabricCanvas.add(state.drawPreview);
  } else if (state.tool === 'circle') {
    state.drawPreview = new fabric.Ellipse({
      left: point.x,
      top: point.y,
      rx: 1,
      ry: 1,
      fill: 'rgba(47,128,237,.08)',
      stroke: '#2f80ed',
      selectable: false,
      evented: false
    });
    state.fabricCanvas.add(state.drawPreview);
  } else if (['line', 'arrow'].includes(state.tool)) {
    state.drawPreview = new fabric.Line([point.x, point.y, point.x, point.y], {
      stroke: '#e53935',
      strokeWidth: 2,
      selectable: false,
      evented: false
    });
    state.fabricCanvas.add(state.drawPreview);
  }
}

function drawingMouseMove(event) {
  if (!state.drawStart || !state.drawPreview) {
    return;
  }
  const point = getCanvasPoint(event.e);
  const start = state.drawStart;
  if (state.tool === 'freehand') {
    state.freehandPoints.push(point);
    state.drawPreview.set({ points: [...state.freehandPoints] });
  } else if (state.drawPreview.type === 'rect') {
    state.drawPreview.set({
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y)
    });
  } else if (state.drawPreview.type === 'ellipse') {
    state.drawPreview.set({
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      rx: Math.abs(point.x - start.x) / 2,
      ry: Math.abs(point.y - start.y) / 2
    });
  } else if (state.drawPreview.type === 'line') {
    state.drawPreview.set({ x2: point.x, y2: point.y });
  }
  state.fabricCanvas.requestRenderAll();
}

async function drawingMouseUp(event) {
  if (state.busy) {
    return;
  }
  const point = getCanvasPoint(event.e);
  const start = state.drawStart || point;
  const tool = state.tool;
  if (state.drawPreview) {
    state.fabricCanvas.remove(state.drawPreview);
  }
  state.drawPreview = null;
  state.drawStart = null;

  try {
    if (tool === 'comment') {
      const text = await requestText('Add comment', 'Comment', '');
      if (text !== null) {
        engine.addComment(state.currentPage, screenPointToPdf(point), text);
        await commitAndRefresh('Add comment');
      }
      return;
    }

    if (!['rectangle', 'circle', 'line', 'arrow', 'freehand', 'crop-page', 'redact', 'add-text'].includes(tool)) {
      return;
    }

    if (Math.hypot(point.x - start.x, point.y - start.y) < 4 && tool !== 'freehand') {
      return;
    }
    const rect = screenRectToPdf([start.x, start.y, point.x, point.y]);

    if (tool === 'rectangle' || tool === 'circle') {
      engine.addShape(state.currentPage, {
        type: tool === 'rectangle' ? 'Square' : 'Circle',
        rect,
        color: [0.1, 0.45, 0.9],
        fillColor: [],
        borderWidth: 2,
        opacity: 1
      });
      await commitAndRefresh(`Add ${tool}`);
    } else if (tool === 'line' || tool === 'arrow') {
      engine.addShape(state.currentPage, {
        type: 'Line',
        points: [screenPointToPdf(start), screenPointToPdf(point)],
        arrow: tool === 'arrow',
        color: [0.9, 0.1, 0.1],
        borderWidth: 2
      });
      await commitAndRefresh(`Add ${tool}`);
    } else if (tool === 'freehand' && state.freehandPoints.length > 1) {
      engine.addShape(state.currentPage, {
        type: 'Ink',
        strokes: [state.freehandPoints.map(screenPointToPdf)],
        color: [0.9, 0.1, 0.1],
        borderWidth: 2
      });
      state.freehandPoints = [];
      await commitAndRefresh('Add freehand drawing');
    } else if (tool === 'redact') {
      engine.addRedaction(state.currentPage, rect);
      await commitAndRefresh('Mark redaction');
    } else if (tool === 'crop-page') {
      engine.cropPage(state.currentPage, rect);
      await commitAndRefresh('Crop page', { rebuildThumbnails: true });
      selectTool('select');
    } else if (tool === 'add-text') {
      const values = await requestTextProperties({
        text: '',
        font: 'Helv',
        fontSize: 12,
        color: '#000000',
        alignment: 0
      }, 'Add text');
      if (values) {
        engine.addText(state.currentPage, rect, values);
        await commitAndRefresh('Add text');
      }
    }
  } catch (error) {
    reportError(error);
  }
}

function getCanvasPoint(nativeEvent) {
  if (typeof state.fabricCanvas.getScenePoint === 'function') {
    return state.fabricCanvas.getScenePoint(nativeEvent);
  }
  return state.fabricCanvas.getPointer(nativeEvent);
}

function screenPointToPdf(point) {
  const bounds = state.render.bounds;
  return [
    point.x / state.render.scale + bounds[0],
    point.y / state.render.scale + bounds[1]
  ];
}

async function editTextLine(line) {
  const values = await requestTextProperties({
    text: line.text,
    font: mapExtractedFont(line.font),
    fontSize: line.font.size,
    color: '#000000',
    alignment: 0
  }, 'Edit existing text');
  if (!values) {
    return;
  }
  engine.replaceExistingText(state.currentPage, line.rect, values);
  await commitAndRefresh('Edit existing text');
}

function mapExtractedFont(font) {
  const name = `${font.name} ${font.family}`.toLowerCase();
  if (name.includes('times') || name.includes('serif')) {
    return 'TiRo';
  }
  if (name.includes('courier') || name.includes('mono')) {
    return 'Cour';
  }
  return 'Helv';
}

async function commitAndRefresh(label, options = {}) {
  setBusy(true, `${label}…`);
  try {
    const mode = elements['save-mode'].value;
    const bytes = engine.serialize(mode);
    vscode.postMessage({
      type: 'document-edited',
      label,
      baseRevision: state.revision,
      data: bytesToBase64(bytes)
    });
    state.revision += 1;
    state.pageCount = engine.countPages();
    state.currentPage = clamp(state.currentPage, 0, Math.max(0, state.pageCount - 1));
    await renderCurrentPage();
    if (options.rebuildThumbnails) {
      void renderThumbnails();
    } else {
      void renderSingleThumbnail(state.currentPage);
    }
    setStatus(label);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

async function renderThumbnails() {
  const token = ++state.thumbnailToken;
  const list = elements['thumbnail-list'];
  list.replaceChildren();
  for (let pageIndex = 0; pageIndex < state.pageCount; pageIndex += 1) {
    if (token !== state.thumbnailToken) {
      return;
    }
    const button = createThumbnailButton(pageIndex);
    list.appendChild(button);
    try {
      const bytes = engine.renderThumbnail(pageIndex);
      const image = button.querySelector('img');
      image.src = uint8ArrayToBlobUrl(bytes, 'image/jpeg');
      image.onload = () => URL.revokeObjectURL(image.src);
    } catch (error) {
      button.classList.add('thumbnail-error');
      console.warn(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderSingleThumbnail(pageIndex) {
  const image = elements['thumbnail-list'].querySelector(`[data-page-index="${pageIndex}"] img`);
  if (!image) {
    return;
  }
  const bytes = engine.renderThumbnail(pageIndex);
  const url = uint8ArrayToBlobUrl(bytes, 'image/jpeg');
  image.src = url;
  image.onload = () => URL.revokeObjectURL(url);
}

function createThumbnailButton(pageIndex) {
  const button = document.createElement('button');
  button.className = `thumbnail-item${pageIndex === state.currentPage ? ' active' : ''}`;
  button.dataset.pageIndex = String(pageIndex);
  button.draggable = true;
  button.innerHTML = `<img alt="Page ${pageIndex + 1}"><span>${pageIndex + 1}</span>`;
  button.addEventListener('click', () => goToPage(pageIndex));
  button.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', String(pageIndex));
    event.dataTransfer.effectAllowed = 'move';
  });
  button.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  button.addEventListener('drop', async (event) => {
    event.preventDefault();
    const fromIndex = Number(event.dataTransfer.getData('text/plain'));
    const toIndex = pageIndex;
    if (Number.isInteger(fromIndex) && fromIndex !== toIndex) {
      engine.reorderPage(fromIndex, toIndex);
      state.currentPage = toIndex;
      await commitAndRefresh('Reorder pages', { rebuildThumbnails: true });
    }
  });
  return button;
}

async function goToPage(pageIndex) {
  const next = clamp(Number(pageIndex), 0, Math.max(0, state.pageCount - 1));
  if (next === state.currentPage) {
    return;
  }
  state.currentPage = next;
  await renderCurrentPage();
  updateActiveThumbnail();
}

function updatePageControls() {
  elements['page-number'].value = String(state.currentPage + 1);
  elements['page-number'].max = String(state.pageCount);
  elements['page-count'].textContent = `/ ${state.pageCount}`;
  elements['previous-page'].disabled = state.currentPage <= 0;
  elements['next-page'].disabled = state.currentPage >= state.pageCount - 1;
  elements['delete-page'].disabled = state.pageCount <= 1;
  updateActiveThumbnail();
}

function updateActiveThumbnail() {
  for (const item of elements['thumbnail-list'].querySelectorAll('.thumbnail-item')) {
    item.classList.toggle('active', Number(item.dataset.pageIndex) === state.currentPage);
  }
  elements['thumbnail-list']
    .querySelector(`[data-page-index="${state.currentPage}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function updateDocumentInfo() {
  const width = state.pageModel.bounds[2] - state.pageModel.bounds[0];
  const height = state.pageModel.bounds[3] - state.pageModel.bounds[1];
  elements['document-info'].textContent = `${state.fileName} · ${state.pageCount} page${state.pageCount === 1 ? '' : 's'} · ${width.toFixed(1)} × ${height.toFixed(1)} pt`;
}

function populateInspector(meta) {
  elements['selection-empty'].classList.add('hidden');
  elements['properties-form'].classList.remove('hidden');
  elements['property-kind'].value = meta.kind;
  elements['property-form-value-row'].classList.add('hidden');
  elements['property-text-row'].classList.remove('hidden');
  elements['property-font-row'].classList.remove('hidden');
  elements['property-alignment-row'].classList.remove('hidden');
  elements['replace-selected-image'].classList.add('hidden');
  elements['crop-selected-image'].classList.add('hidden');
  elements['delete-selection'].classList.remove('hidden');

  if (meta.kind === 'annotation') {
    const annotation = meta.annotation;
    elements['property-text'].value = annotation.contents || '';
    elements['property-font'].value = ['Helv', 'TiRo', 'Cour'].includes(annotation.font)
      ? annotation.font
      : 'Helv';
    elements['property-font-size'].value = String(annotation.fontSize || 12);
    elements['property-color'].value = pdfColorToHex(
      annotation.type === 'FreeText' && annotation.fontColor.length
        ? annotation.fontColor
        : annotation.color,
      '#000000'
    );
    elements['property-fill-color'].value = pdfColorToHex(annotation.interiorColor, '#ffffff');
    elements['property-opacity'].value = String(annotation.opacity ?? 1);
    elements['property-border-width'].value = String(annotation.borderWidth ?? 1);
    elements['property-alignment'].value = String(annotation.alignment || 0);
    const isText = annotation.type === 'FreeText' || annotation.type === 'Text';
    elements['property-font-row'].classList.toggle('hidden', !isText);
    elements['property-alignment-row'].classList.toggle('hidden', annotation.type !== 'FreeText');
    elements['property-text-row'].classList.toggle('hidden', !isText);
    if (annotation.type === 'Stamp') {
      elements['replace-selected-image'].classList.remove('hidden');
      elements['crop-selected-image'].classList.remove('hidden');
    }
  } else if (meta.kind === 'text-line') {
    const line = meta.line;
    elements['property-text'].value = line.text;
    elements['property-font'].value = mapExtractedFont(line.font);
    elements['property-font-size'].value = String(line.font.size || 12);
    elements['property-color'].value = '#000000';
    elements['property-fill-color'].value = '#ffffff';
    elements['property-opacity'].value = '1';
    elements['property-border-width'].value = '0';
    elements['property-alignment'].value = '0';
  } else if (meta.kind === 'image-block') {
    elements['property-text-row'].classList.add('hidden');
    elements['property-font-row'].classList.add('hidden');
    elements['property-alignment-row'].classList.add('hidden');
    elements['replace-selected-image'].classList.remove('hidden');
    elements['crop-selected-image'].classList.remove('hidden');
  } else if (meta.kind === 'widget') {
    elements['property-text-row'].classList.add('hidden');
    elements['property-font-row'].classList.add('hidden');
    elements['property-alignment-row'].classList.add('hidden');
    elements['property-form-value-row'].classList.remove('hidden');
    elements['property-form-value'].value = meta.widget.value || '';
  }
}

function clearInspector() {
  state.selectedMeta = null;
  elements['selection-empty'].classList.remove('hidden');
  elements['properties-form'].classList.add('hidden');
}

function restoreSelection(meta) {
  const object = state.fabricCanvas.getObjects().find((candidate) => {
    const current = candidate.pdfMeta;
    return current?.kind === meta.kind &&
      current.annotationIndex === meta.annotationIndex &&
      current.imageIndex === meta.imageIndex &&
      current.widgetIndex === meta.widgetIndex;
  });
  if (object) {
    state.fabricCanvas.setActiveObject(object);
    state.selectedMeta = object.pdfMeta;
    populateInspector(object.pdfMeta);
    state.fabricCanvas.requestRenderAll();
  }
}

async function applyProperties(event) {
  event.preventDefault();
  const meta = state.selectedMeta;
  if (!meta) {
    return;
  }
  try {
    if (meta.kind === 'annotation') {
      engine.updateAnnotation(state.currentPage, meta.annotationIndex, {
        text: elements['property-text'].value,
        font: elements['property-font'].value,
        fontSize: Number(elements['property-font-size'].value),
        color: hexToPdfColor(elements['property-color'].value),
        fillColor: hexToPdfColor(elements['property-fill-color'].value),
        opacity: Number(elements['property-opacity'].value),
        borderWidth: Number(elements['property-border-width'].value),
        alignment: Number(elements['property-alignment'].value)
      });
      await commitAndRefresh('Edit annotation');
    } else if (meta.kind === 'text-line') {
      engine.replaceExistingText(state.currentPage, meta.line.rect, {
        text: elements['property-text'].value,
        font: elements['property-font'].value,
        fontSize: Number(elements['property-font-size'].value),
        color: hexToPdfColor(elements['property-color'].value),
        alignment: Number(elements['property-alignment'].value)
      });
      await commitAndRefresh('Edit existing text');
    } else if (meta.kind === 'widget') {
      engine.updateWidget(
        state.currentPage,
        meta.widgetIndex,
        elements['property-form-value'].value
      );
      await commitAndRefresh('Fill PDF form');
    }
  } catch (error) {
    reportError(error);
  }
}

async function deleteSelection() {
  const meta = state.selectedMeta;
  if (!meta) {
    return;
  }
  const confirmed = await confirmAction(
    'Delete selected content',
    'This operation changes the PDF. You can undo it with Ctrl+Z.'
  );
  if (!confirmed) {
    return;
  }
  try {
    if (meta.kind === 'annotation') {
      engine.deleteAnnotation(state.currentPage, meta.annotationIndex);
    } else if (meta.kind === 'image-block') {
      engine.deleteExistingContent(state.currentPage, meta.rect, {
        images: true,
        lineArt: false,
        text: false
      });
    } else if (meta.kind === 'text-line') {
      engine.replaceExistingText(state.currentPage, meta.line.rect, { text: '' });
    } else {
      return;
    }
    await commitAndRefresh('Delete selected content');
  } catch (error) {
    reportError(error);
  }
}

function selectTool(tool) {
  state.tool = tool;
  for (const button of document.querySelectorAll('.tool-button')) {
    button.classList.toggle('active', button.dataset.tool === tool);
  }
  elements['text-layer'].classList.toggle('active', tool === 'text-select');
  if (tool === 'image') {
    state.pendingImageAction = { type: 'add' };
    elements['image-file-input'].click();
    return;
  }
  if (state.pageModel && state.fabricCanvas) {
    buildEditingOverlay();
  }
  setStatus(toolHelp(tool));
}

function toolHelp(tool) {
  const help = {
    select: 'Select an annotation, image, or form field. Drag controls to move or resize.',
    'text-select': 'Drag across the transparent text layer to select and copy text.',
    'edit-text': 'Select a detected text line to replace or delete it.',
    'add-text': 'Drag a rectangle where the new text should be placed.',
    image: 'Choose an image to insert into the current page.',
    rectangle: 'Drag to draw a rectangle.',
    circle: 'Drag to draw a circle.',
    line: 'Drag to draw a line.',
    arrow: 'Drag to draw an arrow.',
    freehand: 'Drag to draw a freehand stroke.',
    highlight: 'Select a detected text line to highlight it.',
    underline: 'Select a detected text line to underline it.',
    strikeout: 'Select a detected text line to strike it out.',
    comment: 'Click where the comment icon should be placed.',
    redact: 'Drag over sensitive content, then use Apply redactions permanently.',
    'crop-page': 'Drag the page area that should remain visible.'
  };
  return help[tool] || '';
}

async function handleTextLineTool(meta) {
  if (state.tool === 'edit-text') {
    await editTextLine(meta.line);
  } else {
    const type = {
      highlight: 'Highlight',
      underline: 'Underline',
      strikeout: 'StrikeOut'
    }[state.tool];
    if (type) {
      engine.addTextMarkup(state.currentPage, type, meta.line.rect);
      await commitAndRefresh(`Add ${state.tool}`);
    }
  }
}

async function handleImageFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) {
    selectTool('select');
    return;
  }
  try {
    const bytes = await fileToBytes(file);
    const dimensions = engine.getImageDimensions(bytes);
    const action = state.pendingImageAction || { type: 'add' };
    if (action.type === 'add') {
      const rect = centeredImageRect(dimensions.width, dimensions.height);
      engine.addImage(state.currentPage, rect, bytes);
      await commitAndRefresh('Add image');
    } else if (action.type === 'replace-native') {
      engine.replaceExistingImage(state.currentPage, action.rect, action.rect, bytes);
      await commitAndRefresh('Replace image');
    } else if (action.type === 'replace-annotation') {
      engine.replaceAnnotationImage(
        state.currentPage,
        action.annotationIndex,
        action.rect,
        bytes
      );
      await commitAndRefresh('Replace image');
    }
  } catch (error) {
    reportError(error);
  } finally {
    state.pendingImageAction = null;
    selectTool('select');
  }
}

function centeredImageRect(imageWidth, imageHeight) {
  const bounds = state.pageModel.bounds;
  const pageWidth = bounds[2] - bounds[0];
  const pageHeight = bounds[3] - bounds[1];
  const maximumWidth = pageWidth * 0.6;
  const maximumHeight = pageHeight * 0.6;
  const scale = Math.min(maximumWidth / imageWidth, maximumHeight / imageHeight, 1);
  const width = Math.max(24, imageWidth * scale);
  const height = Math.max(24, imageHeight * scale);
  const x = bounds[0] + (pageWidth - width) / 2;
  const y = bounds[1] + (pageHeight - height) / 2;
  return [x, y, x + width, y + height];
}

async function replaceSelectedImage() {
  const meta = state.selectedMeta;
  if (!meta) {
    return;
  }
  if (meta.kind === 'image-block') {
    state.pendingImageAction = { type: 'replace-native', rect: meta.rect };
  } else if (meta.kind === 'annotation' && meta.annotation.type === 'Stamp') {
    state.pendingImageAction = {
      type: 'replace-annotation',
      annotationIndex: meta.annotationIndex,
      rect: meta.annotation.rect
    };
  } else {
    return;
  }
  elements['image-file-input'].click();
}

async function cropSelectedImage() {
  const meta = state.selectedMeta;
  if (!meta || !['image-block', 'annotation'].includes(meta.kind)) {
    return;
  }
  const values = await requestCropPercentages();
  if (!values) {
    return;
  }
  try {
    const sourceRect = meta.kind === 'image-block' ? meta.rect : meta.annotation.rect;
    const imageBytes = await capturePageRegionAsPng(sourceRect, values);
    if (meta.kind === 'image-block') {
      engine.replaceExistingImage(state.currentPage, sourceRect, sourceRect, imageBytes);
    } else {
      engine.replaceAnnotationImage(
        state.currentPage,
        meta.annotationIndex,
        sourceRect,
        imageBytes
      );
    }
    await commitAndRefresh('Crop image');
  } catch (error) {
    reportError(error);
  }
}

async function capturePageRegionAsPng(pdfRect, crop = { left: 0, top: 0, right: 0, bottom: 0 }) {
  const screen = pdfRectToScreen(pdfRect);
  const sourceWidth = Math.max(1, screen[2] - screen[0]);
  const sourceHeight = Math.max(1, screen[3] - screen[1]);
  const left = sourceWidth * (crop.left || 0) / 100;
  const top = sourceHeight * (crop.top || 0) / 100;
  const right = sourceWidth * (crop.right || 0) / 100;
  const bottom = sourceHeight * (crop.bottom || 0) / 100;
  const width = Math.max(1, sourceWidth - left - right);
  const height = Math.max(1, sourceHeight - top - bottom);
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(width));
  output.height = Math.max(1, Math.round(height));
  output.getContext('2d').drawImage(
    elements['pdf-canvas'],
    screen[0] + left,
    screen[1] + top,
    width,
    height,
    0,
    0,
    output.width,
    output.height
  );
  const blob = await new Promise((resolve, reject) => {
    output.toBlob((value) => value ? resolve(value) : reject(new Error('Could not crop image.')), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function handlePdfFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) {
    return;
  }
  try {
    const bytes = await fileToBytes(file);
    engine.mergePdf(bytes, state.currentPage + 1);
    await commitAndRefresh('Merge PDF documents', { rebuildThumbnails: true });
  } catch (error) {
    reportError(error);
  }
}

async function performSearch() {
  const query = elements['search-input'].value.trim();
  if (!query) {
    state.searchResults = [];
    renderSearchResults();
    buildEditingOverlay();
    return;
  }
  setBusy(true, `Searching for “${query}”…`);
  try {
    state.searchQuery = query;
    state.searchResults = engine.search(query);
    renderSearchResults();
    activateSidebarTab('search');
    buildEditingOverlay();
    setStatus(`${state.searchResults.length} result${state.searchResults.length === 1 ? '' : 's'} for “${query}”.`);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

function renderSearchResults() {
  const container = elements['search-results'];
  container.replaceChildren();
  container.classList.toggle('empty-message', state.searchResults.length === 0);
  if (state.searchResults.length === 0) {
    container.textContent = state.searchQuery ? 'No results.' : 'No search yet.';
    return;
  }
  state.searchResults.forEach((result, index) => {
    const button = document.createElement('button');
    button.className = 'search-result-item';
    button.innerHTML = `<strong>Page ${result.pageIndex + 1}</strong><span>Result ${index + 1}</span>`;
    button.addEventListener('click', () => goToPage(result.pageIndex));
    container.appendChild(button);
  });
}

async function highlightAllSearchResults() {
  if (state.searchResults.length === 0) {
    return;
  }
  try {
    for (const result of state.searchResults) {
      for (const quad of result.quads) {
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        engine.addTextMarkup(result.pageIndex, 'Highlight', [
          Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)
        ]);
      }
    }
    await commitAndRefresh('Highlight search results', { rebuildThumbnails: true });
  } catch (error) {
    reportError(error);
  }
}

function renderOutline(outline) {
  const container = elements['outline-list'];
  container.replaceChildren();
  const items = Array.isArray(outline) ? outline : [];
  if (items.length === 0) {
    container.className = 'outline-list empty-message';
    container.textContent = 'No outline.';
    return;
  }
  container.className = 'outline-list';
  appendOutlineItems(container, items, 0);
}

function appendOutlineItems(container, items, depth) {
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'outline-item';
    button.style.paddingLeft = `${8 + depth * 14}px`;
    button.textContent = item.title || 'Untitled';
    const page = Number(item.page ?? item.pageNumber ?? -1);
    if (Number.isInteger(page) && page >= 0) {
      button.addEventListener('click', () => goToPage(page));
    } else {
      button.disabled = true;
    }
    container.appendChild(button);
    const children = item.down || item.children || [];
    if (Array.isArray(children)) {
      appendOutlineItems(container, children, depth + 1);
    }
  }
}

async function runOcr(scope) {
  let language = elements['ocr-language'].value;
  if (language === 'custom') {
    language = await requestText('OCR language', 'Tesseract language code, for example fra or deu', 'fra');
    if (!language) {
      return;
    }
  }
  const languages = language.includes('+') ? language.split('+') : language;
  const bundled = ['spa', 'eng', 'spa+eng'].includes(language);
  const langPath = bundled
    ? new URL('../vendor/tesseract/languages', import.meta.url).href
    : state.settings.ocrLanguageDataUrl;
  const workerPath = new URL('../vendor/tesseract/worker.min.js', import.meta.url).href;
  const corePath = new URL('../vendor/tesseract/core', import.meta.url).href;
  const pageIndexes = scope === 'document'
    ? Array.from({ length: state.pageCount }, (_, index) => index)
    : [state.currentPage];

  setBusy(true, 'Starting OCR engine…');
  elements['ocr-progress'].classList.remove('hidden');
  elements['ocr-progress'].value = 0;
  let worker;
  try {
    worker = await Tesseract.createWorker(languages, 1, {
      workerPath,
      corePath,
      langPath,
      workerBlobURL: true,
      logger: (message) => {
        const pageProgress = Number(message.progress || 0);
        elements['ocr-progress'].value = pageProgress;
        setBusy(true, `OCR: ${message.status || 'processing'} ${Math.round(pageProgress * 100)}%`);
      }
    });

    for (let position = 0; position < pageIndexes.length; position += 1) {
      const pageIndex = pageIndexes[position];
      setBusy(true, `OCR page ${pageIndex + 1} of ${state.pageCount}…`);
      const imageBytes = engine.exportPageImage(pageIndex, 'png', 200);
      const result = await worker.recognize(
        new Blob([imageBytes], { type: 'image/png' }),
        {},
        { tsv: true, blocks: true }
      );
      const pageModel = engine.getPageModel(pageIndex);
      const words = parseTesseractWords(result.data.tsv || '', pageModel.bounds, 200 / 72);
      engine.addOcrTextLayer(pageIndex, words, language);
      elements['ocr-progress'].value = (position + 1) / pageIndexes.length;
    }
    await commitAndRefresh(
      scope === 'document' ? 'OCR full document' : 'OCR current page',
      { rebuildThumbnails: false }
    );
  } catch (error) {
    reportError(error);
  } finally {
    await worker?.terminate();
    elements['ocr-progress'].classList.add('hidden');
    setBusy(false);
  }
}

function parseTesseractWords(tsv, pageBounds, scale) {
  const lines = String(tsv).split(/\r?\n/);
  const words = [];
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split('\t');
    if (columns.length < 12 || columns[0] !== '5') {
      continue;
    }
    const text = columns.slice(11).join('\t').trim();
    if (!text) {
      continue;
    }
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    words.push({
      text,
      rect: [
        left / scale + pageBounds[0],
        top / scale + pageBounds[1],
        (left + width) / scale + pageBounds[0],
        (top + height) / scale + pageBounds[1]
      ]
    });
  }
  return words;
}

async function exportPages(pageIndexes, suffix) {
  const bytes = engine.exportPages(pageIndexes);
  vscode.postMessage({
    type: 'export',
    suggestedName: `${sanitizeFileStem(state.fileName)}-${suffix}.pdf`,
    data: bytesToBase64(bytes)
  });
}

async function exportPageImage(format) {
  const dpiValue = await requestText('Export page image', 'Resolution in DPI', '150');
  if (dpiValue === null) {
    return;
  }
  const dpi = clamp(Number(dpiValue) || 150, 36, 600);
  const bytes = engine.exportPageImage(state.currentPage, format, dpi);
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  vscode.postMessage({
    type: 'export',
    suggestedName: `${sanitizeFileStem(state.fileName)}-page-${state.currentPage + 1}.${extension}`,
    data: bytesToBase64(bytes)
  });
}

async function splitPdf() {
  const range = await requestText(
    'Extract page range',
    `Pages (1-${state.pageCount}), for example 1-3,5`,
    `1-${state.pageCount}`
  );
  if (range === null) {
    return;
  }
  try {
    const pages = parsePageRange(range, state.pageCount);
    await exportPages(pages, `pages-${range.replace(/[^0-9,-]/g, '')}`);
  } catch (error) {
    reportError(error);
  }
}

async function editMetadata() {
  const metadata = engine.getMetadata();
  const form = await showDialog({
    title: 'Document properties',
    confirmText: 'Apply',
    html: `
      <label>Title<input name="title" value="${escapeHtml(metadata.title || '')}"></label>
      <label>Author<input name="author" value="${escapeHtml(metadata.author || '')}"></label>
      <label>Subject<input name="subject" value="${escapeHtml(metadata.subject || '')}"></label>
      <label>Keywords<input name="keywords" value="${escapeHtml(metadata.keywords || '')}"></label>
      <label>Creator<input name="creator" value="${escapeHtml(metadata.creator || '')}"></label>
    `
  });
  if (!form) {
    return;
  }
  engine.setMetadata(Object.fromEntries(new FormData(form)));
  await commitAndRefresh('Edit document properties');
}

async function showFormsList() {
  const widgets = state.pageModel.widgets;
  await showDialog({
    title: `Form fields on page ${state.currentPage + 1}`,
    confirmText: 'Close',
    hideCancel: true,
    html: widgets.length
      ? `<div class="dialog-list">${widgets.map((widget) => `
          <div><strong>${escapeHtml(widget.label || widget.name || 'Unnamed')}</strong><span>${escapeHtml(widget.type)} · ${escapeHtml(widget.value)}</span></div>
        `).join('')}</div>`
      : '<p>No form fields on the current page.</p>'
  });
}

async function showAttachments() {
  const attachments = engine.listAttachments();
  const form = await showDialog({
    title: 'Embedded files',
    confirmText: 'Add files',
    html: attachments.length
      ? `<div class="dialog-list">${attachments.map((file) => `
          <label class="attachment-row">
            <input type="radio" name="attachment" value="${escapeHtml(file.name)}">
            <span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.mimeType)}</small></span>
          </label>
        `).join('')}</div>
        <div class="dialog-inline-actions">
          <button id="dialog-extract-attachment" type="button">Extract selected</button>
          <button id="dialog-delete-attachment" class="danger-button" type="button">Delete selected</button>
        </div>`
      : '<p>No embedded files. Choose Add files to embed one or more files.</p>',
    onReady: (dialogForm) => {
      dialogForm.querySelector('#dialog-extract-attachment')?.addEventListener('click', () => {
        const name = new FormData(dialogForm).get('attachment');
        if (name) {
          const bytes = engine.extractAttachment(String(name));
          vscode.postMessage({ type: 'export', suggestedName: String(name), data: bytesToBase64(bytes) });
        }
      });
      dialogForm.querySelector('#dialog-delete-attachment')?.addEventListener('click', async () => {
        const name = new FormData(dialogForm).get('attachment');
        if (name) {
          engine.deleteAttachment(String(name));
          await commitAndRefresh('Delete embedded file');
          closeDialog(null);
        }
      });
    }
  });
  if (form) {
    elements['attachment-file-input'].click();
  }
}

async function handleAttachmentFiles(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (files.length === 0) {
    return;
  }
  for (const file of files) {
    engine.addAttachment(file.name, file.type, await fileToBytes(file));
  }
  await commitAndRefresh('Add embedded files');
}

async function handleDocumentAction(action) {
  elements['document-menu'].classList.add('hidden');
  if (action === 'metadata') {
    await editMetadata();
  } else if (action === 'forms') {
    await showFormsList();
  } else if (action === 'attachments') {
    await showAttachments();
  } else if (action === 'merge') {
    elements['pdf-file-input'].click();
  } else if (action === 'split') {
    await splitPdf();
  } else if (action === 'clean') {
    const bytes = engine.serialize('clean');
    vscode.postMessage({
      type: 'document-edited',
      label: 'Optimize PDF',
      baseRevision: state.revision,
      data: bytesToBase64(bytes)
    });
    state.revision += 1;
    engine.load(bytes, state.password);
    await renderCurrentPage();
    setStatus('PDF optimized. Save the document to persist the clean copy.');
  }
}

function toggleDocumentMenu() {
  const menu = elements['document-menu'];
  if (!menu.classList.contains('hidden')) {
    menu.classList.add('hidden');
    return;
  }
  const buttonRect = elements['document-menu-button'].getBoundingClientRect();
  menu.classList.remove('hidden');
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(buttonRect.right - menuRect.width, window.innerWidth - menuRect.width - 8))}px`;
  menu.style.top = `${Math.min(buttonRect.bottom + 4, window.innerHeight - menuRect.height - 8)}px`;
}

function initializeEventHandlers() {
  elements['previous-page'].addEventListener('click', () => goToPage(state.currentPage - 1));
  elements['next-page'].addEventListener('click', () => goToPage(state.currentPage + 1));
  elements['page-number'].addEventListener('change', () => goToPage(Number(elements['page-number'].value) - 1));
  elements['zoom-out'].addEventListener('click', () => changeZoom(-0.25));
  elements['zoom-in'].addEventListener('click', () => changeZoom(0.25));
  elements['zoom-select'].addEventListener('change', async () => {
    const value = elements['zoom-select'].value;
    if (value === 'fit' || value === 'width') {
      state.zoomMode = value;
    } else {
      state.zoomMode = 'numeric';
      state.zoom = Number(value);
    }
    await renderCurrentPage();
  });
  elements['rotate-page'].addEventListener('click', async () => {
    engine.rotatePage(state.currentPage);
    await commitAndRefresh('Rotate page', { rebuildThumbnails: true });
  });
  elements['search-button'].addEventListener('click', performSearch);
  elements['search-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void performSearch();
    }
  });
  elements['undo-button'].addEventListener('click', () => postCommand('undo'));
  elements['redo-button'].addEventListener('click', () => postCommand('redo'));
  elements['save-button'].addEventListener('click', () => postCommand('save'));
  elements['document-menu-button'].addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDocumentMenu();
  });
  elements['toggle-left'].addEventListener('click', () => elements['left-sidebar'].classList.toggle('collapsed'));
  elements['toggle-inspector'].addEventListener('click', () => elements.inspector.classList.toggle('collapsed'));
  elements['properties-form'].addEventListener('submit', applyProperties);
  elements['delete-selection'].addEventListener('click', deleteSelection);
  elements['replace-selected-image'].addEventListener('click', replaceSelectedImage);
  elements['crop-selected-image'].addEventListener('click', cropSelectedImage);
  elements['image-file-input'].addEventListener('change', handleImageFile);
  elements['pdf-file-input'].addEventListener('change', handlePdfFile);
  elements['attachment-file-input'].addEventListener('change', handleAttachmentFiles);
  elements['add-blank-page'].addEventListener('click', async () => {
    engine.addBlankPage(state.currentPage);
    state.currentPage += 1;
    await commitAndRefresh('Add blank page', { rebuildThumbnails: true });
  });
  elements['merge-pdf'].addEventListener('click', () => elements['pdf-file-input'].click());
  elements['duplicate-page'].addEventListener('click', async () => {
    engine.duplicatePage(state.currentPage);
    state.currentPage += 1;
    await commitAndRefresh('Duplicate page', { rebuildThumbnails: true });
  });
  elements['delete-page'].addEventListener('click', async () => {
    if (await confirmAction('Delete page', `Delete page ${state.currentPage + 1}?`)) {
      engine.deletePage(state.currentPage);
      await commitAndRefresh('Delete page', { rebuildThumbnails: true });
    }
  });
  elements['move-page-up'].addEventListener('click', () => movePage(-1));
  elements['move-page-down'].addEventListener('click', () => movePage(1));
  elements['export-page-pdf'].addEventListener('click', () => exportPages([state.currentPage], `page-${state.currentPage + 1}`));
  elements['export-page-png'].addEventListener('click', () => exportPageImage('png'));
  elements['export-page-jpeg'].addEventListener('click', () => exportPageImage('jpeg'));
  elements['split-pdf'].addEventListener('click', splitPdf);
  elements['highlight-search-results'].addEventListener('click', highlightAllSearchResults);
  elements['run-ocr-page'].addEventListener('click', () => runOcr('page'));
  elements['run-ocr-document'].addEventListener('click', () => runOcr('document'));
  elements['apply-redactions'].addEventListener('click', async () => {
    if (await confirmAction('Apply redactions permanently', 'The marked content will be physically removed. You can still use VS Code Undo before saving.')) {
      engine.applyRedactions(null);
      await commitAndRefresh('Apply redactions permanently', { rebuildThumbnails: true });
    }
  });
  elements['flatten-annotations'].addEventListener('click', async () => {
    if (await confirmAction('Flatten annotations', 'Annotations will become static page content and will no longer be individually editable.')) {
      engine.flattenAnnotations();
      await commitAndRefresh('Flatten annotations', { rebuildThumbnails: true });
    }
  });

  for (const button of document.querySelectorAll('.tool-button')) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }
  for (const button of document.querySelectorAll('.sidebar-tab')) {
    button.addEventListener('click', () => activateSidebarTab(button.dataset.sidebarTab));
  }
  for (const button of elements['document-menu'].querySelectorAll('button')) {
    button.addEventListener('click', () => handleDocumentAction(button.dataset.documentAction));
  }

  document.addEventListener('click', (event) => {
    if (!elements['document-menu'].contains(event.target)) {
      elements['document-menu'].classList.add('hidden');
    }
  });
  document.addEventListener('keydown', keyboardHandler);
  window.addEventListener('resize', debounce(async () => {
    if (state.zoomMode !== 'numeric' && state.pageCount > 0) {
      await renderCurrentPage();
    }
  }, 180));
}

async function movePage(offset) {
  const target = state.currentPage + offset;
  if (target < 0 || target >= state.pageCount) {
    return;
  }
  engine.reorderPage(state.currentPage, target);
  state.currentPage = target;
  await commitAndRefresh('Reorder pages', { rebuildThumbnails: true });
}

function keyboardHandler(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    postCommand(event.shiftKey ? 'saveAs' : 'save');
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    postCommand(event.shiftKey ? 'redo' : 'undo');
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    postCommand('redo');
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    elements['search-input'].focus();
    elements['search-input'].select();
  } else if (event.key === 'Delete' && !isFormControl(event.target)) {
    void deleteSelection();
  } else if (event.key === 'Escape') {
    selectTool('select');
  } else if (event.key === 'PageUp' && !isFormControl(event.target)) {
    event.preventDefault();
    void goToPage(state.currentPage - 1);
  } else if (event.key === 'PageDown' && !isFormControl(event.target)) {
    event.preventDefault();
    void goToPage(state.currentPage + 1);
  }
}

function isFormControl(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function postCommand(command) {
  vscode.postMessage({ type: 'command', command });
}

async function changeZoom(delta) {
  state.zoomMode = 'numeric';
  state.zoom = clamp((state.render?.scale || state.zoom) + delta, 0.25, 5);
  syncZoomControl();
  await renderCurrentPage();
}

function syncZoomControl() {
  const exactOption = [...elements['zoom-select'].options]
    .find((option) => Number(option.value) === state.zoom);
  if (exactOption) {
    elements['zoom-select'].value = exactOption.value;
  } else {
    let custom = elements['zoom-select'].querySelector('[data-custom="true"]');
    if (!custom) {
      custom = document.createElement('option');
      custom.dataset.custom = 'true';
      elements['zoom-select'].appendChild(custom);
    }
    custom.value = String(state.zoom);
    custom.textContent = `${Math.round(state.zoom * 100)}%`;
    elements['zoom-select'].value = custom.value;
  }
}

function activateSidebarTab(tabName) {
  for (const tab of document.querySelectorAll('.sidebar-tab')) {
    tab.classList.toggle('active', tab.dataset.sidebarTab === tabName);
  }
  for (const panel of document.querySelectorAll('.sidebar-panel')) {
    panel.classList.toggle('active', panel.id === `${tabName}-panel`);
  }
}

function setBusy(busy, message = '') {
  state.busy = busy;
  elements['loading-overlay'].classList.toggle('hidden', !busy);
  if (message) {
    elements['loading-message'].textContent = message;
  }
  elements.app.setAttribute('aria-busy', String(busy));
}

function setStatus(message, level = 'info') {
  elements['status-message'].textContent = message;
  elements['status-message'].dataset.level = level;
}

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message, 'error');
  setBusy(false);
  vscode.postMessage({ type: 'show-message', level: 'error', message });
  console.error(error);
}

async function requestPassword(invalid) {
  const form = await showDialog({
    title: invalid ? 'Incorrect password' : 'Protected PDF',
    confirmText: 'Open PDF',
    html: `<label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>`
  });
  return form ? String(new FormData(form).get('password') || '') : null;
}

async function requestText(title, label, value) {
  const form = await showDialog({
    title,
    confirmText: 'Confirm',
    html: `<label>${escapeHtml(label)}<input name="value" value="${escapeHtml(value)}" required autofocus></label>`
  });
  return form ? String(new FormData(form).get('value') || '') : null;
}

async function requestTextProperties(values, title) {
  const form = await showDialog({
    title,
    confirmText: 'Apply',
    html: `
      <label>Text<textarea name="text" rows="6" autofocus>${escapeHtml(values.text || '')}</textarea></label>
      <div class="dialog-form-grid">
        <label>Font<select name="font">
          <option value="Helv" ${values.font === 'Helv' ? 'selected' : ''}>Helvetica</option>
          <option value="TiRo" ${values.font === 'TiRo' ? 'selected' : ''}>Times Roman</option>
          <option value="Cour" ${values.font === 'Cour' ? 'selected' : ''}>Courier</option>
        </select></label>
        <label>Size<input name="fontSize" type="number" min="4" max="144" step="0.5" value="${Number(values.fontSize || 12)}"></label>
        <label>Color<input name="color" type="color" value="${escapeHtml(values.color || '#000000')}"></label>
        <label>Alignment<select name="alignment">
          <option value="0" ${Number(values.alignment) === 0 ? 'selected' : ''}>Left</option>
          <option value="1" ${Number(values.alignment) === 1 ? 'selected' : ''}>Center</option>
          <option value="2" ${Number(values.alignment) === 2 ? 'selected' : ''}>Right</option>
        </select></label>
      </div>
    `
  });
  if (!form) {
    return null;
  }
  const data = new FormData(form);
  return {
    text: String(data.get('text') || ''),
    font: String(data.get('font') || 'Helv'),
    fontSize: Number(data.get('fontSize') || 12),
    color: hexToPdfColor(String(data.get('color') || '#000000')),
    alignment: Number(data.get('alignment') || 0)
  };
}

async function requestCropPercentages() {
  const form = await showDialog({
    title: 'Crop image',
    confirmText: 'Crop',
    html: `
      <p>Percentage removed from each edge.</p>
      <div class="dialog-form-grid">
        <label>Left %<input name="left" type="number" min="0" max="90" value="0"></label>
        <label>Top %<input name="top" type="number" min="0" max="90" value="0"></label>
        <label>Right %<input name="right" type="number" min="0" max="90" value="0"></label>
        <label>Bottom %<input name="bottom" type="number" min="0" max="90" value="0"></label>
      </div>
    `
  });
  if (!form) {
    return null;
  }
  const data = new FormData(form);
  const values = Object.fromEntries(['left', 'top', 'right', 'bottom'].map((key) => [
    key,
    clamp(Number(data.get(key) || 0), 0, 90)
  ]));
  if (values.left + values.right >= 100 || values.top + values.bottom >= 100) {
    throw new Error('The crop values remove the complete image.');
  }
  return values;
}

async function confirmAction(title, message) {
  const form = await showDialog({
    title,
    confirmText: 'Continue',
    html: `<p>${escapeHtml(message)}</p>`
  });
  return Boolean(form);
}

let dialogResolver = null;

function showDialog({ title, html, confirmText = 'Confirm', hideCancel = false, onReady = null }) {
  if (dialogResolver) {
    closeDialog(null);
  }
  elements['dialog-title'].textContent = title;
  elements['dialog-content'].innerHTML = html;
  elements['dialog-confirm'].textContent = confirmText;
  elements['dialog-cancel'].classList.toggle('hidden', hideCancel);
  elements['dialog-backdrop'].classList.remove('hidden');
  if (!elements['editor-dialog'].open) {
    elements['editor-dialog'].showModal();
  }
  onReady?.(elements['dialog-form']);
  elements['dialog-content'].querySelector('[autofocus]')?.focus();
  return new Promise((resolve) => {
    dialogResolver = resolve;
  });
}

function closeDialog(result) {
  elements['editor-dialog'].close();
  elements['dialog-backdrop'].classList.add('hidden');
  const resolve = dialogResolver;
  dialogResolver = null;
  resolve?.(result);
}

elements['dialog-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  closeDialog(elements['dialog-form']);
});
elements['dialog-cancel'].addEventListener('click', () => closeDialog(null));
elements['editor-dialog'].addEventListener('cancel', (event) => {
  event.preventDefault();
  closeDialog(null);
});

function debounce(callback, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}
