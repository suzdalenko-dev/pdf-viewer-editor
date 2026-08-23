import { PdfEngine } from './pdf-engine.js';
import {
  base64ToBytes,
  bytesToBase64,
  clamp,
  fileToBytes,
  hexToPdfColor,
  normalizeRect,
  pdfColorToHex
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
  tool: 'edit',
  settings: {
    defaultZoom: 1.25,
    maxRenderPixels: 24_000_000,
    defaultSaveMode: 'incremental'
  },
  render: null,
  pageModel: null,
  fabricCanvas: null,
  overlayObjects: [],
  selected: null,
  editing: null,
  pendingImage: null,
  pendingTable: null,
  drawStart: null,
  drawPreview: null,
  searchQuery: '',
  searchResults: [],
  searchIndex: -1,
  password: '',
  loadToken: 0,
  thumbnailToken: 0,
  thumbnailUrls: new Map(),
  busy: false,
  formatBusy: false,
  dialogRequest: null
};

const elements = Object.fromEntries([
  'app', 'toggle-pages', 'previous-page', 'next-page', 'page-number', 'page-count',
  'zoom-out', 'zoom-select', 'zoom-in', 'search-input', 'search-button',
  'undo-button', 'redo-button', 'save-button', 'edit-text-tool', 'add-text-tool',
  'image-tool', 'table-tool', 'delete-tool', 'tool-hint', 'selection-context',
  'text-context', 'edit-content', 'copy-text', 'text-font-family', 'text-font-size',
  'text-bold', 'text-italic', 'text-color', 'text-alignment', 'table-context',
  'table-rows', 'table-columns', 'table-color', 'table-border-width', 'apply-table',
  'image-context', 'image-kind', 'image-help', 'pages-sidebar', 'thumbnail-list',
  'page-viewport', 'page-stage', 'pdf-canvas', 'text-layer', 'editor-canvas',
  'block-editor', 'block-editor-text', 'cancel-block-edit', 'apply-block-edit',
  'status-message', 'document-info', 'loading-overlay', 'loading-message',
  'dialog-backdrop', 'editor-dialog', 'dialog-form', 'dialog-title',
  'dialog-content', 'dialog-cancel', 'dialog-confirm', 'image-file-input'
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
  setBusy(true, 'Abriendo PDF…');
  cancelBlockEditor();
  clearSelection();
  revokeThumbnailUrls();
  try {
    state.revision = Number(message.revision || 0);
    state.fileName = String(message.fileName || 'document.pdf');
    state.settings = { ...state.settings, ...(message.settings || {}) };
    state.zoom = Number(state.settings.defaultZoom || 1.25);
    state.zoomMode = 'numeric';
    state.password = '';
    state.searchQuery = '';
    state.searchResults = [];
    state.searchIndex = -1;
    state.pendingImage = null;
    state.pendingTable = null;
    setTool('edit');
    elements['search-input'].value = '';
    syncZoomControl();

    const bytes = base64ToBytes(message.data);
    let info = engine.load(bytes);
    while (info.passwordRequired) {
      const password = await requestPassword(Boolean(info.invalidPassword));
      if (password === null) {
        throw new Error('Se necesita una contraseña para abrir este PDF.');
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
    await renderCurrentPage();
    void renderThumbnails();
    elements.app.setAttribute('aria-busy', 'false');
    setStatus('Selecciona un bloque de texto para editarlo.');
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
  setBusy(true, `Renderizando página ${state.currentPage + 1}…`);
  try {
    state.pageModel = engine.getPageModel(state.currentPage);
    const scale = calculateRenderScale(state.pageModel.bounds);
    state.render = engine.renderPage(
      state.currentPage,
      scale,
      Number(state.settings.maxRenderPixels),
      true
    );
    drawRenderedPage();
    initializeOrResizeFabricCanvas();
    buildTextLayer();
    buildEditingOverlay();
    updatePageControls();
    updateDocumentInfo();
    if (!restoreSelection(options)) {
      clearSelection();
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

function drawRenderedPage() {
  const canvas = elements['pdf-canvas'];
  canvas.width = state.render.width;
  canvas.height = state.render.height;
  canvas.style.width = `${state.render.width}px`;
  canvas.style.height = `${state.render.height}px`;
  const context = canvas.getContext('2d', { alpha: true });
  context.putImageData(
    new ImageData(state.render.pixels, state.render.width, state.render.height),
    0,
    0
  );
  elements['page-stage'].style.width = `${state.render.width}px`;
  elements['page-stage'].style.height = `${state.render.height}px`;
}

function initializeOrResizeFabricCanvas() {
  if (!state.fabricCanvas) {
    state.fabricCanvas = new fabric.Canvas('editor-canvas', {
      width: state.render.width,
      height: state.render.height,
      preserveObjectStacking: true,
      selection: false,
      stopContextMenu: true
    });
    state.fabricCanvas.on('selection:created', selectionChanged);
    state.fabricCanvas.on('selection:updated', selectionChanged);
    state.fabricCanvas.on('selection:cleared', () => {
      if (!state.editing) {
        clearSelection();
      }
    });
    state.fabricCanvas.on('mouse:over', overlayMouseOver);
    state.fabricCanvas.on('mouse:out', overlayMouseOut);
    state.fabricCanvas.on('mouse:down', overlayMouseDown);
    state.fabricCanvas.on('mouse:move', overlayMouseMove);
    state.fabricCanvas.on('mouse:up', overlayMouseUp);
    state.fabricCanvas.on('mouse:dblclick', overlayDoubleClick);
    state.fabricCanvas.on('object:modified', overlayObjectModified);
  } else {
    state.fabricCanvas.setDimensions({
      width: state.render.width,
      height: state.render.height
    });
  }
  state.fabricCanvas.clear();
  state.overlayObjects = [];
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
    item.style.fontSize = `${Math.max(4, line.font.size * state.render.scale)}px`;
    item.style.fontFamily = line.font.family;
    layer.appendChild(item);
  }
}

function buildEditingOverlay() {
  const currentHits = state.searchResults.filter((result) =>
    result.pageIndex === state.currentPage
  );
  for (const hit of currentHits) {
    addOverlayObject({ kind: 'search-hit', rect: hit.rect }, {
      fill: 'rgba(255, 215, 0, 0.28)',
      stroke: 'rgba(160, 120, 0, 0.85)',
      selectable: false,
      evented: false
    });
  }

  for (const image of state.pageModel.images) {
    addOverlayObject({ kind: 'native-image', rect: image.rect, image }, {
      stroke: '#7c3aed',
      movable: false,
      resizable: false
    });
  }

  for (const annotation of state.pageModel.annotations) {
    if (annotation.table) {
      addOverlayObject({
        kind: 'table',
        rect: annotation.rect,
        annotationIndex: annotation.index,
        table: annotation.table
      }, {
        stroke: '#0e7490',
        movable: true,
        resizable: true
      });
    } else if (annotation.type === 'Stamp') {
      addOverlayObject({
        kind: 'inserted-image',
        rect: annotation.rect,
        annotationIndex: annotation.index,
        annotation
      }, {
        stroke: '#7c3aed',
        movable: true,
        resizable: true
      });
    }
  }

  for (const block of state.pageModel.textBlocks) {
    addOverlayObject({
      kind: 'text',
      rect: block.rect,
      blockIndex: block.index,
      block
    }, {
      stroke: '#1473e6',
      movable: true,
      resizable: false
    });
  }
  state.fabricCanvas.requestRenderAll();
}

function addOverlayObject(meta, options = {}) {
  const screen = pdfRectToScreen(meta.rect);
  const color = options.stroke || '#1473e6';
  const object = new fabric.Rect({
    left: screen[0],
    top: screen[1],
    width: Math.max(2, screen[2] - screen[0]),
    height: Math.max(2, screen[3] - screen[1]),
    fill: options.fill || 'rgba(0, 0, 0, 0.001)',
    stroke: options.selectable === false ? color : 'rgba(0, 0, 0, 0)',
    strokeWidth: 1.25,
    strokeDashArray: meta.kind === 'text' ? [4, 3] : null,
    transparentCorners: false,
    cornerColor: color,
    cornerStrokeColor: '#ffffff',
    cornerSize: 9,
    borderColor: color,
    hasRotatingPoint: false,
    lockRotation: true,
    selectable: options.selectable !== false,
    evented: options.evented !== false,
    hasControls: Boolean(options.resizable),
    lockMovementX: !options.movable,
    lockMovementY: !options.movable,
    lockScalingX: !options.resizable,
    lockScalingY: !options.resizable,
    hoverCursor: options.movable ? 'move' : 'pointer'
  });
  object.editorMeta = meta;
  object.editorStroke = color;
  object.setControlsVisibility({ mtr: false });
  state.fabricCanvas.add(object);
  state.overlayObjects.push({ meta, object });
  return object;
}

function overlayMouseOver(event) {
  const object = event.target;
  if (!object?.editorMeta || object === state.fabricCanvas.getActiveObject()) {
    return;
  }
  object.set('stroke', object.editorStroke);
  state.fabricCanvas.requestRenderAll();
}

function overlayMouseOut(event) {
  const object = event.target;
  if (!object?.editorMeta || object === state.fabricCanvas.getActiveObject()) {
    return;
  }
  object.set('stroke', 'rgba(0, 0, 0, 0)');
  state.fabricCanvas.requestRenderAll();
}

function selectionChanged(event) {
  const object = event.selected?.[0];
  if (!object?.editorMeta) {
    clearSelection();
    return;
  }
  selectMeta(object.editorMeta);
}

function selectMeta(meta) {
  state.selected = meta;
  elements['delete-tool'].disabled = false;
  elements['selection-context'].classList.remove('hidden');
  elements['text-context'].classList.toggle('hidden', meta.kind !== 'text');
  elements['table-context'].classList.toggle('hidden', meta.kind !== 'table');
  elements['image-context'].classList.toggle(
    'hidden',
    !['native-image', 'inserted-image'].includes(meta.kind)
  );

  if (meta.kind === 'text') {
    setTextControlsFromBlock(meta.block);
    setStatus('Bloque seleccionado: cambia el formato o pulsa “Editar contenido”.');
  } else if (meta.kind === 'table') {
    elements['table-rows'].value = String(meta.table.rows);
    elements['table-columns'].value = String(meta.table.columns);
    elements['table-color'].value = pdfColorToHex(meta.table.color);
    elements['table-border-width'].value = String(meta.table.borderWidth);
    setStatus('Tabla seleccionada: cambia filas/columnas, muévela o elimínala.');
  } else if (meta.kind === 'inserted-image') {
    elements['image-kind'].textContent = 'Imagen insertada';
    elements['image-help'].textContent = 'Arrastra para mover; usa las esquinas para redimensionar.';
    setStatus('Imagen seleccionada.');
  } else {
    elements['image-kind'].textContent = 'Imagen original';
    elements['image-help'].textContent = 'Esta imagen original se puede eliminar permanentemente.';
    setStatus('Imagen original seleccionada.');
  }
}

function clearSelection() {
  state.selected = null;
  elements['delete-tool'].disabled = true;
  elements['selection-context'].classList.add('hidden');
  elements['text-context'].classList.add('hidden');
  elements['table-context'].classList.add('hidden');
  elements['image-context'].classList.add('hidden');
  if (state.fabricCanvas?.getActiveObject()) {
    state.fabricCanvas.discardActiveObject();
    state.fabricCanvas.requestRenderAll();
  }
}

function overlayMouseDown(event) {
  if (state.busy) {
    return;
  }
  const pointer = state.fabricCanvas.getScenePoint(event.e);
  if (state.tool === 'add-text') {
    event.e.preventDefault();
    openNewTextEditor(screenPointToPdf(pointer));
    return;
  }
  if (state.tool === 'place-image' && state.pendingImage) {
    event.e.preventDefault();
    void placePendingImage(screenPointToPdf(pointer));
    return;
  }
  if (state.tool === 'table' && state.pendingTable) {
    event.e.preventDefault();
    state.drawStart = pointer;
    state.drawPreview = new fabric.Rect({
      left: pointer.x,
      top: pointer.y,
      width: 1,
      height: 1,
      fill: 'rgba(14, 116, 144, 0.08)',
      stroke: '#0e7490',
      strokeDashArray: [6, 4],
      selectable: false,
      evented: false
    });
    state.fabricCanvas.add(state.drawPreview);
  }
}

function overlayMouseMove(event) {
  if (!state.drawStart || !state.drawPreview) {
    return;
  }
  const pointer = state.fabricCanvas.getScenePoint(event.e);
  state.drawPreview.set({
    left: Math.min(state.drawStart.x, pointer.x),
    top: Math.min(state.drawStart.y, pointer.y),
    width: Math.abs(pointer.x - state.drawStart.x),
    height: Math.abs(pointer.y - state.drawStart.y)
  });
  state.drawPreview.setCoords();
  state.fabricCanvas.requestRenderAll();
}

function overlayMouseUp(event) {
  if (!state.drawStart || !state.pendingTable) {
    return;
  }
  const pointer = state.fabricCanvas.getScenePoint(event.e);
  const start = state.drawStart;
  let screenRect = normalizeRect([start.x, start.y, pointer.x, pointer.y]);
  if (screenRect[2] - screenRect[0] < 40 || screenRect[3] - screenRect[1] < 30) {
    screenRect = [
      start.x,
      start.y,
      Math.min(state.render.width - 8, start.x + 260),
      Math.min(state.render.height - 8, start.y + 140)
    ];
  }
  state.fabricCanvas.remove(state.drawPreview);
  state.drawPreview = null;
  state.drawStart = null;
  const table = state.pendingTable;
  state.pendingTable = null;
  setTool('edit');
  engine.addTable(
    state.currentPage,
    screenRectToPdf(screenRect),
    table.rows,
    table.columns,
    { color: table.color, borderWidth: table.borderWidth }
  );
  void commitAndRefresh('Añadir tabla', { restoreKind: 'table-last' });
}

function overlayDoubleClick(event) {
  const meta = event.target?.editorMeta;
  if (meta?.kind === 'text') {
    openExistingTextEditor(meta.block);
  }
}

async function overlayObjectModified(event) {
  const object = event.target;
  const meta = object?.editorMeta;
  if (!meta || state.busy) {
    return;
  }
  const targetRect = objectScreenRectToPdf(object);
  try {
    if (meta.kind === 'text') {
      engine.moveTextBlock(state.currentPage, meta.blockIndex, targetRect);
      await commitAndRefresh('Mover texto', { restoreText: meta.block.text });
    } else if (meta.kind === 'inserted-image') {
      engine.updateAnnotationRect(state.currentPage, meta.annotationIndex, targetRect);
      await commitAndRefresh('Mover o redimensionar imagen', {
        restoreKind: 'image-last'
      });
    } else if (meta.kind === 'table') {
      engine.updateTable(
        state.currentPage,
        meta.annotationIndex,
        targetRect,
        meta.table.rows,
        meta.table.columns,
        { color: meta.table.color, borderWidth: meta.table.borderWidth }
      );
      await commitAndRefresh('Mover o redimensionar tabla', {
        restoreKind: 'table-last'
      });
    }
  } catch (error) {
    reportError(error);
    await renderCurrentPage();
  }
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

function screenPointToPdf(point) {
  const bounds = state.render.bounds;
  return [
    point.x / state.render.scale + bounds[0],
    point.y / state.render.scale + bounds[1]
  ];
}

function objectScreenRectToPdf(object) {
  const width = Math.max(2, object.width * object.scaleX);
  const height = Math.max(2, object.height * object.scaleY);
  return screenRectToPdf([
    object.left,
    object.top,
    object.left + width,
    object.top + height
  ]);
}

function setTextControlsFromBlock(block) {
  elements['text-font-family'].value = block.font.editableFamily || 'Helvetica';
  elements['text-font-size'].value = String(Number(block.font.size || 12).toFixed(1));
  setToggle(elements['text-bold'], Boolean(block.font.bold || block.font.weight === 'bold'));
  setToggle(elements['text-italic'], Boolean(block.font.italic || block.font.style === 'italic'));
  elements['text-color'].value = pdfColorToHex(block.color, '#000000');
  elements['text-alignment'].value = String(block.alignment || 0);
}

function setDefaultTextControls() {
  elements['text-font-family'].value = 'Helvetica';
  elements['text-font-size'].value = '12';
  setToggle(elements['text-bold'], false);
  setToggle(elements['text-italic'], false);
  elements['text-color'].value = '#000000';
  elements['text-alignment'].value = '0';
}

function getTextFormat() {
  return {
    fontFamily: elements['text-font-family'].value,
    fontSize: clamp(Number(elements['text-font-size'].value || 12), 4, 144),
    bold: elements['text-bold'].getAttribute('aria-pressed') === 'true',
    italic: elements['text-italic'].getAttribute('aria-pressed') === 'true',
    color: hexToPdfColor(elements['text-color'].value),
    alignment: Number(elements['text-alignment'].value || 0)
  };
}

function setToggle(button, active) {
  button.setAttribute('aria-pressed', String(active));
}

function toggleFormatButton(button) {
  setToggle(button, button.getAttribute('aria-pressed') !== 'true');
  void textFormatChanged();
}

async function textFormatChanged() {
  syncBlockEditorPreview();
  if (state.editing || state.formatBusy || state.selected?.kind !== 'text') {
    return;
  }
  state.formatBusy = true;
  const block = state.selected.block;
  try {
    engine.editTextBlock(state.currentPage, block.index, {
      text: block.text,
      ...getTextFormat()
    });
    await commitAndRefresh('Cambiar formato de texto', { restoreText: block.text });
  } catch (error) {
    reportError(error);
  } finally {
    state.formatBusy = false;
  }
}

function openExistingTextEditor(block) {
  state.selected = {
    kind: 'text',
    rect: block.rect,
    blockIndex: block.index,
    block
  };
  setTextControlsFromBlock(block);
  showTextContext();
  openBlockEditor({
    mode: 'edit',
    blockIndex: block.index,
    rect: block.rect,
    text: block.text
  });
}

function openNewTextEditor(point) {
  const bounds = state.pageModel.bounds;
  const x = clamp(point[0], bounds[0] + 8, bounds[2] - 70);
  const y = clamp(point[1], bounds[1] + 8, bounds[3] - 24);
  const width = Math.min(300, Math.max(60, bounds[2] - x - 24));
  setDefaultTextControls();
  showTextContext();
  openBlockEditor({
    mode: 'add',
    blockIndex: null,
    rect: [x, y, x + width, y + 18],
    text: ''
  });
  setTool('edit');
}

function showTextContext() {
  elements['selection-context'].classList.remove('hidden');
  elements['text-context'].classList.remove('hidden');
  elements['table-context'].classList.add('hidden');
  elements['image-context'].classList.add('hidden');
}

function openBlockEditor(editing) {
  state.editing = editing;
  const screen = pdfRectToScreen(editing.rect);
  const editor = elements['block-editor'];
  editor.style.left = `${clamp(screen[0], 0, Math.max(0, state.render.width - 190))}px`;
  editor.style.top = `${clamp(screen[1], 0, Math.max(0, state.render.height - 90))}px`;
  editor.style.width = `${Math.max(180, Math.min(state.render.width, screen[2] - screen[0]))}px`;
  editor.classList.remove('hidden');
  elements['block-editor-text'].value = editing.text;
  syncBlockEditorPreview();
  autoGrowBlockEditor();
  elements['block-editor-text'].focus();
  elements['block-editor-text'].select();
  setStatus(editing.mode === 'add'
    ? 'Escribe el texto nuevo y pulsa Aplicar.'
    : 'Edita el bloque; el contenido inferior se desplazará automáticamente.');
}

function syncBlockEditorPreview() {
  if (!state.editing) {
    return;
  }
  const format = getTextFormat();
  const textarea = elements['block-editor-text'];
  textarea.style.fontFamily = cssFontFamily(format.fontFamily);
  textarea.style.fontSize = `${Math.max(8, format.fontSize * state.render.scale)}px`;
  textarea.style.fontWeight = format.bold ? 'bold' : 'normal';
  textarea.style.fontStyle = format.italic ? 'italic' : 'normal';
  textarea.style.color = elements['text-color'].value;
  textarea.style.textAlign = ['left', 'center', 'right'][format.alignment] || 'left';
  autoGrowBlockEditor();
}

function cssFontFamily(fontFamily) {
  if (fontFamily === 'Times-Roman') {
    return 'Times New Roman, serif';
  }
  if (fontFamily === 'Courier') {
    return 'Courier New, monospace';
  }
  return 'Arial, Helvetica, sans-serif';
}

function autoGrowBlockEditor() {
  if (!state.editing) {
    return;
  }
  const textarea = elements['block-editor-text'];
  textarea.style.height = 'auto';
  textarea.style.height = `${clamp(textarea.scrollHeight + 4, 64, 420)}px`;
}

function cancelBlockEditor() {
  state.editing = null;
  elements['block-editor'].classList.add('hidden');
  elements['block-editor-text'].value = '';
  if (!state.selected) {
    clearSelection();
  }
}

async function applyBlockEditor() {
  if (!state.editing || state.busy) {
    return;
  }
  const editing = state.editing;
  const text = elements['block-editor-text'].value;
  const values = { text, ...getTextFormat() };
  cancelBlockEditor();
  if (editing.mode === 'add') {
    if (!text.trim()) {
      setStatus('No se añadió texto vacío.');
      return;
    }
    engine.insertTextBlock(state.currentPage, editing.rect, values);
    await commitAndRefresh('Añadir texto', { restoreText: text });
  } else {
    engine.editTextBlock(state.currentPage, editing.blockIndex, values);
    await commitAndRefresh(text ? 'Editar texto' : 'Eliminar texto', {
      restoreText: text || null
    });
  }
}

async function deleteSelection() {
  if (!state.selected || state.busy) {
    return;
  }
  const selected = state.selected;
  clearSelection();
  if (selected.kind === 'text') {
    engine.editTextBlock(state.currentPage, selected.blockIndex, { text: '' });
    await commitAndRefresh('Eliminar texto');
  } else if (selected.kind === 'native-image') {
    engine.deleteExistingContent(state.currentPage, selected.rect, {
      images: true,
      lineArt: false,
      text: false
    });
    await commitAndRefresh('Eliminar imagen');
  } else if (selected.kind === 'inserted-image') {
    engine.deleteAnnotation(state.currentPage, selected.annotationIndex);
    await commitAndRefresh('Eliminar imagen');
  } else if (selected.kind === 'table') {
    engine.deleteAnnotation(state.currentPage, selected.annotationIndex);
    await commitAndRefresh('Eliminar tabla');
  }
}

async function copySelectedText() {
  const text = state.selected?.kind === 'text' ? state.selected.block.text : '';
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
  setStatus('Texto copiado.');
}

async function applyTableProperties() {
  if (state.selected?.kind !== 'table' || state.busy) {
    return;
  }
  const selected = state.selected;
  engine.updateTable(
    state.currentPage,
    selected.annotationIndex,
    selected.rect,
    Number(elements['table-rows'].value),
    Number(elements['table-columns'].value),
    {
      color: hexToPdfColor(elements['table-color'].value),
      borderWidth: Number(elements['table-border-width'].value)
    }
  );
  await commitAndRefresh('Actualizar tabla', { restoreKind: 'table-last' });
}

async function chooseTableTool() {
  const values = await showFieldsDialog({
    title: 'Crear tabla',
    confirmText: 'Elegir zona',
    fields: [
      { name: 'rows', label: 'Filas', type: 'number', value: '3', min: '1', max: '30' },
      { name: 'columns', label: 'Columnas', type: 'number', value: '3', min: '1', max: '20' },
      { name: 'color', label: 'Color de línea', type: 'color', value: '#000000' },
      { name: 'borderWidth', label: 'Grosor', type: 'number', value: '1', min: '0.25', max: '8', step: '0.25' }
    ],
    grid: true
  });
  if (!values) {
    return;
  }
  state.pendingTable = {
    rows: Number(values.rows),
    columns: Number(values.columns),
    color: hexToPdfColor(values.color),
    borderWidth: Number(values.borderWidth)
  };
  setTool('table');
  setStatus('Arrastra sobre la página para colocar la tabla.');
}

async function handleImageFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) {
    return;
  }
  try {
    const bytes = await fileToBytes(file);
    const dimensions = engine.getImageDimensions(bytes);
    state.pendingImage = { bytes, dimensions };
    setTool('place-image');
    setStatus('Haz clic en la página para colocar la imagen.');
  } catch (error) {
    reportError(error);
  }
}

async function placePendingImage(point) {
  const pending = state.pendingImage;
  if (!pending) {
    return;
  }
  state.pendingImage = null;
  setTool('edit');
  const bounds = state.pageModel.bounds;
  const aspectRatio = pending.dimensions.height / Math.max(1, pending.dimensions.width);
  let width = Math.min(180, Math.max(40, bounds[2] - point[0] - 18));
  let height = width * aspectRatio;
  if (point[1] + height > bounds[3] - 18) {
    height = Math.max(30, bounds[3] - point[1] - 18);
    width = height / Math.max(0.01, aspectRatio);
  }
  engine.addImage(state.currentPage, [
    point[0],
    point[1],
    point[0] + width,
    point[1] + height
  ], pending.bytes);
  await commitAndRefresh('Añadir imagen', { restoreKind: 'image-last' });
}

async function commitAndRefresh(label, options = {}) {
  setBusy(true, `${label}…`);
  try {
    const bytes = engine.serialize(state.settings.defaultSaveMode);
    vscode.postMessage({
      type: 'document-edited',
      label,
      baseRevision: state.revision,
      data: bytesToBase64(bytes)
    });
    state.revision += 1;
    state.pageCount = engine.countPages();
    state.currentPage = clamp(state.currentPage, 0, Math.max(0, state.pageCount - 1));
    await renderCurrentPage(options);
    void renderSingleThumbnail(state.currentPage);
    setStatus(`${label}. Guarda el archivo para conservar el cambio.`);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

function restoreSelection(options) {
  let entry = null;
  if (options.restoreText) {
    const prefix = String(options.restoreText).trim().slice(0, 48);
    entry = state.overlayObjects.find(({ meta }) =>
      meta.kind === 'text' && meta.block.text.includes(prefix)
    );
  } else if (options.restoreKind === 'table-last') {
    entry = state.overlayObjects.findLast(({ meta }) => meta.kind === 'table');
  } else if (options.restoreKind === 'image-last') {
    entry = state.overlayObjects.findLast(({ meta }) => meta.kind === 'inserted-image');
  }
  if (!entry) {
    return false;
  }
  state.fabricCanvas.setActiveObject(entry.object);
  entry.object.set('stroke', entry.object.editorStroke);
  state.fabricCanvas.requestRenderAll();
  selectMeta(entry.meta);
  return true;
}

async function performSearch() {
  const query = elements['search-input'].value.trim();
  if (!query) {
    state.searchQuery = '';
    state.searchResults = [];
    state.searchIndex = -1;
    await renderCurrentPage();
    setStatus('Escribe texto para buscar.');
    return;
  }
  if (query !== state.searchQuery) {
    state.searchQuery = query;
    state.searchResults = engine.search(query);
    state.searchIndex = -1;
  }
  if (state.searchResults.length === 0) {
    await renderCurrentPage();
    setStatus(`No se encontró “${query}”.`);
    return;
  }
  state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
  const result = state.searchResults[state.searchIndex];
  if (state.currentPage !== result.pageIndex) {
    state.currentPage = result.pageIndex;
  }
  await renderCurrentPage();
  setStatus(`Resultado ${state.searchIndex + 1} de ${state.searchResults.length}.`);
}

async function renderThumbnails() {
  const token = ++state.thumbnailToken;
  elements['thumbnail-list'].replaceChildren();
  for (let pageIndex = 0; pageIndex < state.pageCount; pageIndex += 1) {
    if (token !== state.thumbnailToken) {
      return;
    }
    const button = document.createElement('button');
    button.className = 'thumbnail-button';
    button.dataset.pageIndex = String(pageIndex);
    const image = document.createElement('img');
    image.alt = `Miniatura de la página ${pageIndex + 1}`;
    const label = document.createElement('span');
    label.textContent = String(pageIndex + 1);
    button.append(image, label);
    button.addEventListener('click', () => goToPage(pageIndex));
    elements['thumbnail-list'].appendChild(button);
    await updateThumbnailImage(button, image, pageIndex);
  }
  updateThumbnailSelection();
}

async function renderSingleThumbnail(pageIndex) {
  const button = elements['thumbnail-list'].querySelector(
    `[data-page-index="${pageIndex}"]`
  );
  const image = button?.querySelector('img');
  if (button && image) {
    await updateThumbnailImage(button, image, pageIndex);
    updateThumbnailSelection();
  }
}

async function updateThumbnailImage(button, image, pageIndex) {
  try {
    const bytes = engine.renderThumbnail(pageIndex, 142);
    const previousUrl = state.thumbnailUrls.get(pageIndex);
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    state.thumbnailUrls.set(pageIndex, url);
    image.src = url;
    button.title = `Ir a la página ${pageIndex + 1}`;
  } catch (error) {
    button.title = error instanceof Error ? error.message : String(error);
  }
}

function revokeThumbnailUrls() {
  for (const url of state.thumbnailUrls.values()) {
    URL.revokeObjectURL(url);
  }
  state.thumbnailUrls.clear();
}

function updateThumbnailSelection() {
  for (const button of elements['thumbnail-list'].querySelectorAll('.thumbnail-button')) {
    button.classList.toggle(
      'active',
      Number(button.dataset.pageIndex) === state.currentPage
    );
  }
}

async function goToPage(pageIndex) {
  const target = clamp(Math.round(pageIndex), 0, Math.max(0, state.pageCount - 1));
  if (target === state.currentPage && state.pageModel) {
    return;
  }
  cancelBlockEditor();
  state.currentPage = target;
  await renderCurrentPage();
  updateThumbnailSelection();
  elements['page-viewport'].scrollTo({ top: 0, left: 0 });
}

function updatePageControls() {
  elements['page-number'].value = String(state.currentPage + 1);
  elements['page-number'].max = String(Math.max(1, state.pageCount));
  elements['page-count'].textContent = `/ ${state.pageCount}`;
  elements['previous-page'].disabled = state.currentPage <= 0;
  elements['next-page'].disabled = state.currentPage >= state.pageCount - 1;
  updateThumbnailSelection();
}

function updateDocumentInfo() {
  const dimensions = state.pageModel.bounds;
  const width = Math.round(dimensions[2] - dimensions[0]);
  const height = Math.round(dimensions[3] - dimensions[1]);
  elements['document-info'].textContent = `${state.fileName} · ${width} × ${height} pt`;
}

function setTool(tool) {
  state.tool = tool;
  if (state.fabricCanvas) {
    state.fabricCanvas.skipTargetFind = tool !== 'edit';
    state.fabricCanvas.selection = false;
    if (tool !== 'edit') {
      state.fabricCanvas.discardActiveObject();
      state.fabricCanvas.requestRenderAll();
    }
  }
  const visibleTool = tool === 'place-image' ? 'image' : tool;
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('active', button.dataset.tool === visibleTool);
  }
  const hints = {
    edit: 'Selecciona un bloque para editarlo.',
    'add-text': 'Haz clic donde quieras escribir.',
    'place-image': 'Haz clic donde quieras colocar la imagen.',
    table: 'Arrastra para definir el tamaño de la tabla.'
  };
  elements['tool-hint'].textContent = hints[tool] || '';
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
    return;
  }
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

function initializeEventHandlers() {
  elements['toggle-pages'].addEventListener('click', () => {
    elements['pages-sidebar'].classList.toggle('collapsed');
  });
  elements['previous-page'].addEventListener('click', () => goToPage(state.currentPage - 1));
  elements['next-page'].addEventListener('click', () => goToPage(state.currentPage + 1));
  elements['page-number'].addEventListener('change', () => {
    void goToPage(Number(elements['page-number'].value) - 1);
  });
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
  elements['search-button'].addEventListener('click', performSearch);
  elements['search-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void performSearch();
    }
  });
  elements['undo-button'].addEventListener('click', () => postCommand('undo'));
  elements['redo-button'].addEventListener('click', () => postCommand('redo'));
  elements['save-button'].addEventListener('click', () => postCommand('save'));

  elements['edit-text-tool'].addEventListener('click', () => {
    setTool('edit');
    if (state.selected?.kind === 'text') {
      openExistingTextEditor(state.selected.block);
    }
  });
  elements['add-text-tool'].addEventListener('click', () => {
    cancelBlockEditor();
    clearSelection();
    setTool('add-text');
    setStatus('Haz clic en cualquier punto de la página para escribir.');
  });
  elements['image-tool'].addEventListener('click', () => {
    elements['image-file-input'].click();
  });
  elements['table-tool'].addEventListener('click', chooseTableTool);
  elements['delete-tool'].addEventListener('click', deleteSelection);
  elements['edit-content'].addEventListener('click', () => {
    if (state.selected?.kind === 'text') {
      openExistingTextEditor(state.selected.block);
    }
  });
  elements['copy-text'].addEventListener('click', copySelectedText);
  elements['text-font-family'].addEventListener('change', textFormatChanged);
  elements['text-font-size'].addEventListener('change', textFormatChanged);
  elements['text-color'].addEventListener('change', textFormatChanged);
  elements['text-alignment'].addEventListener('change', textFormatChanged);
  elements['text-bold'].addEventListener('click', () => toggleFormatButton(elements['text-bold']));
  elements['text-italic'].addEventListener('click', () => toggleFormatButton(elements['text-italic']));
  elements['apply-table'].addEventListener('click', applyTableProperties);
  elements['image-file-input'].addEventListener('change', handleImageFile);
  elements['block-editor-text'].addEventListener('input', autoGrowBlockEditor);
  elements['block-editor-text'].addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void applyBlockEditor();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelBlockEditor();
    }
  });
  elements['cancel-block-edit'].addEventListener('click', cancelBlockEditor);
  elements['apply-block-edit'].addEventListener('click', applyBlockEditor);

  elements['dialog-form'].addEventListener('submit', submitDialog);
  elements['dialog-cancel'].addEventListener('click', () => closeDialog(null));
  document.addEventListener('keydown', keyboardHandler);
  window.addEventListener('resize', debounce(async () => {
    if (state.zoomMode !== 'numeric' && state.pageCount > 0) {
      await renderCurrentPage();
    }
  }, 180));
  window.addEventListener('beforeunload', () => {
    revokeThumbnailUrls();
    engine.destroy();
  });
}

function keyboardHandler(event) {
  if (state.dialogRequest && event.key === 'Escape') {
    event.preventDefault();
    closeDialog(null);
    return;
  }
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
  } else if (event.key === 'Escape' && !state.editing) {
    state.pendingImage = null;
    state.pendingTable = null;
    if (state.drawPreview) {
      state.fabricCanvas.remove(state.drawPreview);
      state.drawPreview = null;
      state.drawStart = null;
    }
    setTool('edit');
  } else if (event.key === 'PageUp' && !isFormControl(event.target)) {
    event.preventDefault();
    void goToPage(state.currentPage - 1);
  } else if (event.key === 'PageDown' && !isFormControl(event.target)) {
    event.preventDefault();
    void goToPage(state.currentPage + 1);
  }
}

function isFormControl(target) {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
}

function postCommand(command) {
  vscode.postMessage({ type: 'command', command });
}

async function requestPassword(invalid) {
  const values = await showFieldsDialog({
    title: invalid ? 'Contraseña incorrecta' : 'PDF protegido',
    confirmText: 'Abrir PDF',
    fields: [{
      name: 'password',
      label: 'Contraseña',
      type: 'password',
      value: '',
      required: true,
      autocomplete: 'current-password'
    }]
  });
  return values ? String(values.password || '') : null;
}

function showFieldsDialog(options) {
  if (state.dialogRequest) {
    closeDialog(null);
  }
  elements['dialog-title'].textContent = options.title;
  elements['dialog-confirm'].textContent = options.confirmText || 'Aceptar';
  elements['dialog-content'].replaceChildren();
  const fieldContainer = document.createElement('div');
  if (options.grid) {
    fieldContainer.className = 'dialog-grid';
  }
  for (const field of options.fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement('input');
    input.name = field.name;
    input.type = field.type || 'text';
    input.value = field.value || '';
    for (const attribute of ['min', 'max', 'step', 'autocomplete']) {
      if (field[attribute] !== undefined) {
        input.setAttribute(attribute, String(field[attribute]));
      }
    }
    input.required = Boolean(field.required);
    label.appendChild(input);
    fieldContainer.appendChild(label);
  }
  elements['dialog-content'].appendChild(fieldContainer);
  elements['dialog-backdrop'].classList.remove('hidden');
  elements['editor-dialog'].setAttribute('open', '');
  fieldContainer.querySelector('input')?.focus();
  return new Promise((resolve) => {
    state.dialogRequest = { resolve };
  });
}

function submitDialog(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(elements['dialog-form']).entries());
  closeDialog(values);
}

function closeDialog(value) {
  const request = state.dialogRequest;
  state.dialogRequest = null;
  elements['editor-dialog'].removeAttribute('open');
  elements['dialog-backdrop'].classList.add('hidden');
  request?.resolve(value);
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

function debounce(callback, delay) {
  let timeout = null;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}
