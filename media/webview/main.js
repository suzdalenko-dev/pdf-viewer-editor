import { PdfEngine } from './pdf-engine.js';
import {
  base64ToBytes,
  bytesToBase64,
  clamp,
  fileToBytes,
  hexToPdfColor,
  invertMatrix,
  normalizeRect,
  pdfColorToHex,
  transformPoint
} from './utils.js';

const vscode = acquireVsCodeApi();
const engine = new PdfEngine();

const state = {
  revision: 0,
  fileName: 'document.pdf',
  currentPage: 0,
  pageCount: 0,
  zoom: 1,
  zoomMode: 'numeric',
  tool: 'edit',
  settings: {
    defaultZoom: 1,
    maxRenderPixels: 24_000_000,
    defaultSaveMode: 'incremental'
  },
  render: null,
  pageModel: null,
  fabricCanvas: null,
  overlayObjects: [],
  selected: null,
  textRange: null,
  textDrag: null,
  textResizeObject: null,
  editing: null,
  insertionAnchor: null,
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
  'text-context', 'edit-content', 'resize-text-block', 'copy-text', 'text-font-family', 'text-font-size',
  'text-bold', 'text-italic', 'text-color', 'text-alignment', 'table-context',
  'table-rows', 'table-columns', 'table-color', 'table-border-width', 'apply-table',
  'image-context', 'image-kind', 'image-help', 'pages-sidebar', 'thumbnail-list',
  'page-viewport', 'page-stage', 'pdf-canvas', 'text-layer', 'editor-canvas',
  'insertion-layer', 'insert-menu', 'insert-text-here', 'insert-image-here',
  'insert-table-here', 'edit-range-button',
  'block-editor', 'block-editor-text', 'cancel-block-edit', 'apply-block-edit',
  'status-message', 'document-info', 'loading-overlay', 'loading-message',
  'dialog-backdrop', 'editor-dialog', 'dialog-form', 'dialog-title',
  'dialog-content', 'dialog-cancel', 'dialog-confirm', 'image-file-input'
].map((id) => [id, document.getElementById(id)]));

const blockEditorResizeObserver = new window.ResizeObserver(() => {
  if (state.editing && !elements['block-editor'].classList.contains('hidden')) {
    syncEditingRectFromEditor();
  }
});
blockEditorResizeObserver.observe(elements['block-editor-text']);

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message.type === 'load-document') {
    await loadDocument(message);
  } else if (message.type === 'operation-error') {
    setBusy(false);
    setStatus(message.message, 'error');
  } else if (message.type === 'document-saved') {
    setBusy(false);
    setStatus('PDF guardado correctamente.');
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
    state.zoom = Number(state.settings.defaultZoom || 1);
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
    setStatus('Haz clic en un párrafo, selecciona una frase o usa + para insertar.');
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
  hideInsertMenu();
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
    buildInsertionLayer();
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
      enableRetinaScaling: false,
      stopContextMenu: true
    });
    state.fabricCanvas.on('selection:created', selectionChanged);
    state.fabricCanvas.on('selection:updated', selectionChanged);
    state.fabricCanvas.on('selection:cleared', () => {
      if (!state.editing && state.selected?.kind !== 'text') {
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
  syncFabricCanvasGeometry();
  state.fabricCanvas.clear();
  state.overlayObjects = [];
  state.textResizeObject = null;
}

function syncFabricCanvasGeometry() {
  if (!state.fabricCanvas || !state.render) {
    return;
  }
  const width = `${state.render.width}px`;
  const height = `${state.render.height}px`;
  const wrapper = state.fabricCanvas.wrapperEl;
  if (wrapper) {
    Object.assign(wrapper.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width,
      height,
      margin: '0px'
    });
  }
  for (const canvas of [state.fabricCanvas.lowerCanvasEl, state.fabricCanvas.upperCanvasEl]) {
    if (!canvas) {
      continue;
    }
    Object.assign(canvas.style, {
      left: '0px',
      top: '0px',
      width,
      height,
      margin: '0px'
    });
  }
}

function buildTextLayer() {
  const layer = elements['text-layer'];
  layer.replaceChildren();
  layer.style.width = `${state.render.width}px`;
  layer.style.height = `${state.render.height}px`;
  layer.classList.toggle('disabled', state.tool !== 'edit');
  layer.classList.toggle('placement-mode', state.tool !== 'edit');
  for (const line of state.pageModel.textLines) {
    const screen = pdfRectToScreen(line.rect);
    const item = document.createElement('span');
    item.className = 'text-layer-line';
    item.textContent = line.text;
    item.dataset.blockIndex = String(line.blockIndex);
    item.dataset.lineIndex = String(line.lineIndex);
    item.dataset.textStart = String(line.textStart);
    item.dataset.textEnd = String(line.textEnd);
    item.title = 'Haz clic para seleccionar la línea; arrastra para seleccionar texto exacto';
    item.style.left = `${screen[0]}px`;
    item.style.top = `${screen[1]}px`;
    item.style.width = `${Math.max(1, screen[2] - screen[0])}px`;
    item.style.height = `${Math.max(1, screen[3] - screen[1])}px`;
    item.addEventListener('pointerdown', (event) => beginTextSelection(event, line));
    item.addEventListener('pointermove', updateTextSelectionDrag);
    item.addEventListener('pointerup', finishTextSelection);
    item.addEventListener('pointercancel', cancelTextSelectionDrag);
    item.addEventListener('dblclick', (event) => selectWordAtPointer(event, line));
    layer.appendChild(item);
  }
}

function beginTextSelection(event, line) {
  if (state.tool !== 'edit' || state.busy || state.editing || event.button !== 0) {
    return;
  }
  event.preventDefault();
  hideInsertMenu();
  clearNativeTextSelection();
  setTextResizeMode(false);
  const position = textOffsetAtScreenPoint(line.blockIndex, event.clientX, event.clientY);
  if (!position) {
    return;
  }
  state.textDrag = {
    pointerId: event.pointerId,
    blockIndex: line.blockIndex,
    lineStart: line.textStart,
    lineEnd: line.textEnd,
    anchorOffset: position.offset,
    lastOffset: position.offset,
    startX: event.clientX,
    startY: event.clientY,
    moved: false
  };
  const target = /** @type {HTMLElement | null} */ (event.currentTarget);
  target?.setPointerCapture(event.pointerId);
}

function updateTextSelectionDrag(event) {
  const drag = state.textDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (!drag.moved && distance < 3) {
    return;
  }
  drag.moved = true;
  const position = textOffsetAtScreenPoint(
    drag.blockIndex,
    event.clientX,
    event.clientY
  );
  if (!position) {
    return;
  }
  drag.lastOffset = position.offset;
  setTextRange(drag.blockIndex, drag.anchorOffset, drag.lastOffset, { quiet: true });
}

function finishTextSelection(event) {
  const drag = state.textDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  state.textDrag = null;
  const target = /** @type {HTMLElement | null} */ (event.currentTarget);
  if (target?.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }
  if (drag.moved) {
    setTextRange(drag.blockIndex, drag.anchorOffset, drag.lastOffset);
  } else {
    setTextRange(drag.blockIndex, drag.lineStart, drag.lineEnd);
  }
}

function cancelTextSelectionDrag(event) {
  if (state.textDrag?.pointerId === event.pointerId) {
    state.textDrag = null;
  }
}

function selectWordAtPointer(event, line) {
  if (state.tool !== 'edit' || state.busy || state.editing) {
    return;
  }
  event.preventDefault();
  const position = textOffsetAtScreenPoint(line.blockIndex, event.clientX, event.clientY);
  const block = state.pageModel?.textBlocks.find((candidate) =>
    candidate.index === line.blockIndex
  );
  if (!position || !block?.text) {
    return;
  }
  let index = clamp(position.offset, 0, Math.max(0, block.text.length - 1));
  if (!isWordCharacter(block.text[index]) && index > 0 && isWordCharacter(block.text[index - 1])) {
    index -= 1;
  }
  if (!isWordCharacter(block.text[index])) {
    setTextRange(block.index, index, Math.min(block.text.length, index + 1));
    return;
  }
  let start = index;
  let end = index + 1;
  while (start > 0 && isWordCharacter(block.text[start - 1])) {
    start -= 1;
  }
  while (end < block.text.length && isWordCharacter(block.text[end])) {
    end += 1;
  }
  setTextRange(block.index, start, end);
}

function isWordCharacter(character) {
  return Boolean(character && /[\p{L}\p{N}\p{M}_]/u.test(character));
}

function textOffsetAtScreenPoint(blockIndex, clientX, clientY) {
  const block = state.pageModel?.textBlocks.find((candidate) =>
    candidate.index === blockIndex
  );
  if (!block) {
    return null;
  }
  const stageRect = elements['page-stage'].getBoundingClientRect();
  const point = [clientX - stageRect.left, clientY - stageRect.top];
  const lines = block.visualLines || [];
  const line = lines.reduce((closest, candidate) => {
    const rect = pdfRectToScreen(candidate.rect);
    const distance = distanceToRect(point, rect);
    return !closest || distance < closest.distance
      ? { line: candidate, distance }
      : closest;
  }, null)?.line;
  if (!line) {
    return null;
  }

  const characters = (line.characters || [])
    .filter((character) =>
      Array.isArray(character.rect) && character.rect.length === 4 &&
      Number.isFinite(character.start) && Number.isFinite(character.end)
    )
    .sort((left, right) => left.start - right.start);
  if (characters.length === 0) {
    const screen = pdfRectToScreen(line.rect);
    const ratio = clamp((point[0] - screen[0]) / Math.max(1, screen[2] - screen[0]), 0, 1);
    return {
      blockIndex,
      offset: Math.round(line.textStart + ratio * line.text.length)
    };
  }

  const closest = characters.reduce((result, character) => {
    const rect = pdfRectToScreen(character.rect);
    const distance = distanceToRect(point, rect);
    return !result || distance < result.distance
      ? { character, rect, distance }
      : result;
  }, null);
  const offset = point[0] < (closest.rect[0] + closest.rect[2]) / 2
    ? closest.character.start
    : closest.character.end;
  return { blockIndex, offset };
}

function distanceToRect(point, rect) {
  const dx = Math.max(rect[0] - point[0], 0, point[0] - rect[2]);
  const dy = Math.max(rect[1] - point[1], 0, point[1] - rect[3]);
  return Math.hypot(dx, dy);
}

function selectTextBlock(blockIndex, options = {}) {
  const block = state.pageModel?.textBlocks.find((candidate) => candidate.index === blockIndex);
  if (!block) {
    return false;
  }
  if (!options.preserveRange) {
    state.textRange = null;
    hideEditRangeButton();
    clearTextRangeHighlights();
  }
  const meta = {
    kind: 'text',
    rect: block.rect,
    blockIndex: block.index,
    block
  };
  state.selected = meta;
  if (state.fabricCanvas?.getActiveObject()) {
    state.fabricCanvas.discardActiveObject();
    state.fabricCanvas.requestRenderAll();
  }
  selectMeta(meta);
  return true;
}

function setTextRange(blockIndex, start, end, options = {}) {
  const block = state.pageModel?.textBlocks.find((candidate) =>
    candidate.index === blockIndex
  );
  if (!block) {
    return false;
  }
  const rangeStart = clamp(Math.min(start, end), 0, block.text.length);
  const rangeEnd = clamp(Math.max(start, end), 0, block.text.length);
  if (rangeEnd <= rangeStart) {
    state.textRange = null;
    clearTextRangeHighlights();
    hideEditRangeButton();
    return false;
  }
  state.textRange = {
    blockIndex: block.index,
    start: rangeStart,
    end: rangeEnd,
    text: block.text.slice(rangeStart, rangeEnd)
  };
  renderTextRangeHighlights();
  selectTextBlock(block.index, { preserveRange: true });
  showEditRangeButton(getTextRangeRects(state.textRange));
  if (!options.quiet) {
    setStatus('Texto seleccionado: pulsa “Editar selección”, cambia su formato o elimínalo.');
  }
  return true;
}

function showEditRangeButton(pdfRects) {
  if (!Array.isArray(pdfRects) || pdfRects.length === 0) {
    hideEditRangeButton();
    return;
  }
  const button = elements['edit-range-button'];
  const selectionRect = pdfRects.map(pdfRectToScreen).reduce((result, rect) => [
    Math.min(result[0], rect[0]),
    Math.min(result[1], rect[1]),
    Math.max(result[2], rect[2]),
    Math.max(result[3], rect[3])
  ]);
  const width = 126;
  button.style.left = `${clamp(
    selectionRect[0] + (selectionRect[2] - selectionRect[0]) / 2 - width / 2,
    4,
    Math.max(4, state.render.width - width - 4)
  )}px`;
  button.style.top = `${clamp(
    selectionRect[3] + 5,
    4,
    Math.max(4, state.render.height - 34)
  )}px`;
  button.classList.remove('hidden');
}

function hideEditRangeButton() {
  elements['edit-range-button'].classList.add('hidden');
}

function clearTextRangeHighlights() {
  for (const highlight of elements['text-layer'].querySelectorAll('.text-range-highlight')) {
    highlight.remove();
  }
}

function getTextRangeRects(selectedRange) {
  if (!selectedRange || !state.pageModel) {
    return [];
  }

  const rects = [];
  const lines = state.pageModel.textLines.filter((line) =>
    line.blockIndex === selectedRange.blockIndex &&
    selectedRange.end > line.textStart &&
    selectedRange.start < line.textEnd
  );

  for (const line of lines) {
    const localStart = clamp(selectedRange.start - line.textStart, 0, line.text.length);
    const localEnd = clamp(selectedRange.end - line.textStart, 0, line.text.length);
    if (localEnd <= localStart) {
      continue;
    }

    const characters = Array.isArray(line.characters) ? line.characters : [];
    const selectedCharacters = characters
      .filter((character) =>
        Number.isFinite(character.start) && Number.isFinite(character.end) &&
        character.end > selectedRange.start && character.start < selectedRange.end
      )
      .map((character) => character.rect)
      .filter((candidate) => Array.isArray(candidate) && candidate.length === 4);

    if (selectedCharacters.length > 0) {
      rects.push(selectedCharacters.reduce((result, candidate) => result
        ? [
            Math.min(result[0], candidate[0]),
            Math.min(result[1], candidate[1]),
            Math.max(result[2], candidate[2]),
            Math.max(result[3], candidate[3])
          ]
        : [...candidate], null));
      continue;
    }

    const lineWidth = Math.max(1, line.rect[2] - line.rect[0]);
    const startRatio = localStart / Math.max(1, line.text.length);
    const endRatio = localEnd / Math.max(1, line.text.length);
    rects.push([
      line.rect[0] + lineWidth * startRatio,
      line.rect[1],
      line.rect[0] + lineWidth * endRatio,
      line.rect[3]
    ]);
  }

  return rects;
}

function getTextRangeRect(selectedRange) {
  const rects = getTextRangeRects(selectedRange);
  if (rects.length === 0) {
    return null;
  }
  return rects.reduce((result, rect) => [
    Math.min(result[0], rect[0]),
    Math.min(result[1], rect[1]),
    Math.max(result[2], rect[2]),
    Math.max(result[3], rect[3])
  ], [...rects[0]]);
}

function renderTextRangeHighlights() {
  clearTextRangeHighlights();
  for (const rect of getTextRangeRects(state.textRange)) {
    const screen = pdfRectToScreen(rect);
    const highlight = document.createElement('div');
    highlight.className = 'text-range-highlight';
    highlight.style.left = `${screen[0]}px`;
    highlight.style.top = `${screen[1]}px`;
    highlight.style.width = `${Math.max(1, screen[2] - screen[0])}px`;
    highlight.style.height = `${Math.max(1, screen[3] - screen[1])}px`;
    elements['text-layer'].appendChild(highlight);
  }
}

function setTextResizeMode(active) {
  if (!active && state.textResizeObject && state.fabricCanvas) {
    state.fabricCanvas.remove(state.textResizeObject);
    state.overlayObjects = state.overlayObjects.filter(({ object }) =>
      object !== state.textResizeObject
    );
    state.textResizeObject = null;
    state.fabricCanvas.requestRenderAll();
  }
  const wrapper = state.fabricCanvas?.wrapperEl;
  if (wrapper) {
    wrapper.style.zIndex = active ? '6' : '3';
  }
  elements['text-layer'].classList.toggle('resize-mode', active);
  elements['insertion-layer'].classList.toggle('resize-mode', active);
}

function activateTextResizeMode() {
  const selected = state.selected;
  if (selected?.kind !== 'text' || state.busy) {
    return;
  }

  setTextResizeMode(false);
  setTextResizeMode(true);
  const resizeMeta = { ...selected, resizeMode: true };
  const object = addOverlayObject(resizeMeta, {
    stroke: '#1473e6',
    fill: 'rgba(20, 115, 230, 0.025)',
    movable: true,
    resizable: true
  });
  state.textResizeObject = object;
  state.fabricCanvas.setActiveObject(object);
  object.set('stroke', object.editorStroke);
  state.fabricCanvas.requestRenderAll();
  setStatus('Arrastra el marco para mover el texto o sus esquinas para cambiar la anchura; al soltar se recompone el texto.');
}

function buildInsertionLayer() {
  const layer = elements['insertion-layer'];
  layer.replaceChildren();
  layer.style.width = `${state.render.width}px`;
  layer.style.height = `${state.render.height}px`;
  const blocks = [...state.pageModel.textBlocks].sort((left, right) =>
    left.rect[1] - right.rect[1] || left.rect[0] - right.rect[0]
  );
  const bounds = state.pageModel.bounds;
  const anchors = [];

  if (blocks.length === 0) {
    anchors.push({
      x: bounds[0] + 24,
      y: bounds[1] + 36,
      width: Math.max(100, bounds[2] - bounds[0] - 48),
      displayY: bounds[1] + 36,
      label: 'Insertar contenido en la página'
    });
  } else {
    const first = blocks[0];
    anchors.push({
      x: first.rect[0],
      y: Math.max(bounds[1] + 6, first.rect[1] - 10),
      width: Math.max(80, first.rect[2] - first.rect[0]),
      displayY: Math.max(bounds[1] + 6, first.rect[1] - 10),
      label: 'Insertar antes del primer párrafo'
    });
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1];
      const current = blocks[index];
      if (!rectanglesShareScreenFlow(previous.rect, current.rect)) {
        continue;
      }
      const displayY = Math.max(
        previous.rect[3] + 2,
        (previous.rect[3] + current.rect[1]) / 2
      );
      anchors.push({
        x: current.rect[0],
        y: displayY,
        width: Math.max(80, current.rect[2] - current.rect[0]),
        displayY,
        label: `Insertar antes de “${current.text.slice(0, 36)}”`
      });
    }
    const last = blocks.at(-1);
    const afterY = Math.min(bounds[3] - 8, last.rect[3] + 10);
    anchors.push({
      x: last.rect[0],
      y: afterY,
      width: Math.max(80, last.rect[2] - last.rect[0]),
      displayY: afterY,
      label: 'Insertar después del último párrafo'
    });
  }

  const usedPositions = [];
  for (const anchor of anchors) {
    const screenPoint = pdfPointToScreen([anchor.x, anchor.displayY]);
    if (usedPositions.some((position) => Math.abs(position - screenPoint[1]) < 8)) {
      continue;
    }
    usedPositions.push(screenPoint[1]);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'insertion-marker';
    button.setAttribute('aria-label', anchor.label);
    button.title = `${anchor.label}: texto, imagen o tabla`;
    button.style.left = `${Math.max(2, screenPoint[0] - 24)}px`;
    button.style.top = `${clamp(screenPoint[1] - 9, 1, state.render.height - 19)}px`;
    button.style.width = `${Math.min(
      state.render.width - Math.max(2, screenPoint[0] - 24) - 2,
      Math.max(54, anchor.width * state.render.scale + 24)
    )}px`;
    button.innerHTML = '<span class="insertion-plus">+</span><span class="insertion-guide"></span>';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openInsertMenu(anchor, button);
    });
    layer.appendChild(button);
  }
}

function rectanglesShareScreenFlow(left, right) {
  const overlap = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const minimumWidth = Math.max(1, Math.min(left[2] - left[0], right[2] - right[0]));
  return overlap / minimumWidth >= 0.25;
}

function pdfPointToScreen(point) {
  return transformPoint(state.render.pageToScreen, point);
}

function openInsertMenu(anchor, marker) {
  state.insertionAnchor = anchor;
  const menu = elements['insert-menu'];
  const markerRect = marker.getBoundingClientRect();
  const stageRect = elements['page-stage'].getBoundingClientRect();
  menu.classList.remove('hidden');
  const menuWidth = Math.max(220, menu.offsetWidth);
  menu.style.left = `${clamp(
    markerRect.left - stageRect.left,
    4,
    Math.max(4, state.render.width - menuWidth - 4)
  )}px`;
  menu.style.top = `${clamp(
    markerRect.bottom - stageRect.top + 3,
    4,
    Math.max(4, state.render.height - menu.offsetHeight - 4)
  )}px`;
}

function hideInsertMenu(options = {}) {
  elements['insert-menu'].classList.add('hidden');
  if (!options.preserveAnchor) {
    state.insertionAnchor = null;
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
    originX: 'left',
    originY: 'top',
    strokeUniform: true,
    centeredScaling: false,
    padding: 0,
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
    lockScalingFlip: true,
    minScaleLimit: 0.02,
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
  if (meta.kind !== 'text') {
    setTextResizeMode(false);
    state.textRange = null;
    hideEditRangeButton();
    clearTextRangeHighlights();
    clearNativeTextSelection();
  }
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
    setStatus(state.textRange
      ? 'Texto seleccionado: edítalo, cambia su formato o elimínalo.'
      : 'Párrafo seleccionado: pulsa “Editar contenido” o selecciona una frase.');
  } else if (meta.kind === 'table') {
    elements['table-rows'].value = String(meta.table.rows);
    elements['table-columns'].value = String(meta.table.columns);
    elements['table-color'].value = pdfColorToHex(meta.table.color);
    elements['table-border-width'].value = String(meta.table.borderWidth);
    setStatus('Tabla seleccionada: cambia filas/columnas, muévela o elimínala.');
  } else if (meta.kind === 'inserted-image') {
    elements['image-kind'].textContent = 'Imagen insertada';
    elements['image-help'].textContent = 'Arrastra para mover, usa las esquinas para redimensionar o pulsa Imagen para reemplazarla.';
    setStatus('Imagen seleccionada: puedes moverla, redimensionarla, reemplazarla o eliminarla.');
  } else {
    elements['image-kind'].textContent = 'Imagen original';
    elements['image-help'].textContent = 'Pulsa Imagen para reemplazarla manteniendo su zona, o Eliminar para quitarla.';
    setStatus('Imagen original seleccionada: puedes reemplazarla o eliminarla.');
  }
}

function clearSelection() {
  state.selected = null;
  state.textRange = null;
  state.textDrag = null;
  hideEditRangeButton();
  clearTextRangeHighlights();
  setTextResizeMode(false);
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

function clearNativeTextSelection() {
  window.getSelection()?.removeAllRanges();
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
  engine.insertTableBlock(
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
  if (meta?.kind === 'table') {
    void applyTableProperties();
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
    if (meta.kind === 'inserted-image') {
      engine.updateAnnotationRect(state.currentPage, meta.annotationIndex, targetRect);
      await commitAndRefresh('Mover o redimensionar imagen', {
        restoreKind: 'image-last'
      });
    } else if (meta.kind === 'text' && meta.resizeMode) {
      setTextResizeMode(false);
      engine.resizeTextBlock(state.currentPage, meta.blockIndex, targetRect);
      await commitAndRefresh('Mover o redimensionar texto', {
        restoreText: meta.block.text
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
  const topLeft = pdfPointToScreen([x0, y0]);
  const bottomRight = pdfPointToScreen([x1, y1]);
  return normalizeRect([...topLeft, ...bottomRight]);
}

function screenRectToPdf(rect) {
  const topLeft = screenPointToPdf({ x: rect[0], y: rect[1] });
  const bottomRight = screenPointToPdf({ x: rect[2], y: rect[3] });
  return normalizeRect([...topLeft, ...bottomRight]);
}

function screenPointToPdf(point) {
  return transformPoint(
    invertMatrix(state.render.pageToScreen),
    [Number(point.x), Number(point.y)]
  );
}

function objectScreenRectToPdf(object) {
  // All editable Fabric objects are axis-aligned with a left/top origin.
  // Using the object's content box (not getBoundingRect, which includes the
  // visual stroke) keeps the blue frame and the PDF target rectangle identical.
  const left = Number(object.left || 0);
  const top = Number(object.top || 0);
  const width = Math.max(2, Number(object.width || 0) * Math.abs(Number(object.scaleX || 1)));
  const height = Math.max(2, Number(object.height || 0) * Math.abs(Number(object.scaleY || 1)));
  return screenRectToPdf([left, top, left + width, top + height]);
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
  const selectedRange = state.textRange;
  try {
    if (selectedRange?.blockIndex === block.index) {
      engine.editTextRange(
        state.currentPage,
        block.index,
        selectedRange.start,
        selectedRange.end,
        selectedRange.text,
        getTextFormat()
      );
      await commitAndRefresh('Cambiar formato de la selección', {
        restoreText: selectedRange.text
      });
    } else {
      engine.editTextBlock(state.currentPage, block.index, {
        text: block.text,
        ...getTextFormat()
      });
      await commitAndRefresh('Cambiar formato de texto', { restoreText: block.text });
    }
  } catch (error) {
    reportError(error);
  } finally {
    state.formatBusy = false;
  }
}

function openExistingTextEditor(block) {
  state.textRange = null;
  hideEditRangeButton();
  clearNativeTextSelection();
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

function openSelectedRangeEditor() {
  const selectedRange = state.textRange;
  if (!selectedRange || state.busy) {
    return;
  }
  const block = state.pageModel.textBlocks.find((candidate) =>
    candidate.index === selectedRange.blockIndex
  );
  if (!block) {
    return;
  }
  setTextControlsFromBlock(block);
  showTextContext();
  openBlockEditor({
    mode: 'range',
    blockIndex: block.index,
    start: selectedRange.start,
    end: selectedRange.end,
    sourceRect: block.rect,
    rect: getTextRangeRect(selectedRange) || block.rect,
    text: selectedRange.text
  });
}

function openNewTextEditor(pointOrAnchor) {
  const bounds = state.pageModel.bounds;
  const point = Array.isArray(pointOrAnchor)
    ? pointOrAnchor
    : [pointOrAnchor.x, pointOrAnchor.y];
  const x = clamp(point[0], bounds[0] + 8, bounds[2] - 70);
  const y = clamp(point[1], bounds[1] + 8, bounds[3] - 24);
  const requestedWidth = Array.isArray(pointOrAnchor) ? null : pointOrAnchor.width;
  const width = Math.min(
    requestedWidth || 300,
    Math.max(60, bounds[2] - x - 24)
  );
  setDefaultTextControls();
  showTextContext();
  openBlockEditor({
    mode: 'add',
    blockIndex: null,
    rect: [x, y, x + width, Math.min(bounds[3] - 8, y + 72)],
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
  state.editing = {
    ...editing,
    rect: [...editing.rect],
    sourceRect: editing.sourceRect ? [...editing.sourceRect] : null,
    initialRect: [...editing.rect]
  };
  hideEditRangeButton();
  clearNativeTextSelection();
  const screen = pdfRectToScreen(editing.rect);
  const editor = elements['block-editor'];
  const textarea = elements['block-editor-text'];
  const left = clamp(screen[0], 0, Math.max(0, state.render.width - 24));
  const top = clamp(screen[1], 0, Math.max(0, state.render.height - 18));
  const requestedWidth = Math.max(24, screen[2] - screen[0]);
  const requestedHeight = Math.max(18, screen[3] - screen[1]);
  const width = clamp(requestedWidth, 24, Math.max(24, state.render.width - left));
  const height = clamp(requestedHeight, 18, Math.max(18, state.render.height - top));

  editor.style.left = `${left}px`;
  editor.style.top = `${top}px`;
  textarea.style.width = `${width}px`;
  textarea.style.height = `${height}px`;
  editor.classList.remove('hidden');
  textarea.value = editing.text;
  syncBlockEditorPreview();
  syncEditingRectFromEditor();
  state.editing.initialRect = [...state.editing.rect];
  textarea.focus();
  textarea.select();
  setStatus(editing.mode === 'add'
    ? 'Escribe dentro del marco azul. Puedes arrastrar su esquina para cambiar anchura y altura.'
    : (editing.mode === 'range'
      ? 'El marco azul coincide con la selección. Edita el texto y redimensiona el área si lo necesitas.'
      : 'El marco azul es el área real del bloque. Redimensiónalo para cambiar el reflow.'));
}

function syncEditingRectFromEditor() {
  if (!state.editing || elements['block-editor'].classList.contains('hidden')) {
    return;
  }
  const textareaRect = elements['block-editor-text'].getBoundingClientRect();
  const stageRect = elements['page-stage'].getBoundingClientRect();
  const screenRect = normalizeRect([
    clamp(textareaRect.left - stageRect.left, 0, state.render.width),
    clamp(textareaRect.top - stageRect.top, 0, state.render.height),
    clamp(textareaRect.right - stageRect.left, 0, state.render.width),
    clamp(textareaRect.bottom - stageRect.top, 0, state.render.height)
  ]);
  state.editing.rect = screenRectToPdf(screenRect);
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
  syncEditingRectFromEditor();
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

function cancelBlockEditor() {
  const rangeWasOpen = state.editing?.mode === 'range';
  state.editing = null;
  elements['block-editor'].classList.add('hidden');
  elements['block-editor-text'].value = '';
  if (rangeWasOpen) {
    state.textRange = null;
    clearTextRangeHighlights();
  }
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
  } else if (editing.mode === 'range') {
    const sourceRect = editing.sourceRect || editing.rect;
    const initialWidth = Math.max(1, editing.initialRect[2] - editing.initialRect[0]);
    const editedWidth = Math.max(1, editing.rect[2] - editing.rect[0]);
    const targetWidth = Math.max(
      24,
      sourceRect[2] - sourceRect[0] + editedWidth - initialWidth
    );
    engine.editTextRange(
      state.currentPage,
      editing.blockIndex,
      editing.start,
      editing.end,
      text,
      {
        ...values,
        targetRect: [
          sourceRect[0],
          sourceRect[1],
          sourceRect[0] + targetWidth,
          sourceRect[3]
        ]
      }
    );
    await commitAndRefresh(text ? 'Editar selección' : 'Eliminar selección', {
      restoreText: text || null
    });
  } else {
    engine.editTextBlock(state.currentPage, editing.blockIndex, {
      ...values,
      targetRect: editing.rect
    });
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
  const selectedRange = state.textRange;
  clearSelection();
  if (selected.kind === 'text') {
    if (selectedRange?.blockIndex === selected.blockIndex) {
      engine.editTextRange(
        state.currentPage,
        selected.blockIndex,
        selectedRange.start,
        selectedRange.end,
        ''
      );
      await commitAndRefresh('Eliminar selección');
    } else {
      engine.editTextBlock(state.currentPage, selected.blockIndex, { text: '' });
      await commitAndRefresh('Eliminar texto');
    }
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
  const text = state.selected?.kind === 'text'
    ? (state.textRange?.text || state.selected.block.text)
    : '';
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

async function chooseTableTool(anchor = null) {
  const values = await showFieldsDialog({
    title: 'Crear tabla',
    confirmText: anchor ? 'Insertar' : 'Elegir zona',
    fields: [
      { name: 'rows', label: 'Filas', type: 'number', value: '3', min: '1', max: '30' },
      { name: 'columns', label: 'Columnas', type: 'number', value: '3', min: '1', max: '20' },
      { name: 'color', label: 'Color de línea', type: 'color', value: '#000000' },
      { name: 'borderWidth', label: 'Grosor', type: 'number', value: '1', min: '0.25', max: '8', step: '0.25' }
    ],
    grid: true
  });
  if (!values) {
    hideInsertMenu();
    return;
  }
  if (anchor) {
    hideInsertMenu();
    const rowCount = Number(values.rows);
    const tableHeight = clamp(rowCount * 24, 54, 360);
    engine.insertTableBlock(
      state.currentPage,
      [anchor.x, anchor.y, anchor.x + anchor.width, anchor.y + tableHeight],
      rowCount,
      Number(values.columns),
      {
        color: hexToPdfColor(values.color),
        borderWidth: Number(values.borderWidth)
      }
    );
    await commitAndRefresh('Insertar tabla', { restoreKind: 'table-last' });
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
    const selectedImage = ['native-image', 'inserted-image'].includes(state.selected?.kind)
      ? state.selected
      : null;

    if (selectedImage?.kind === 'native-image') {
      const targetRect = [...selectedImage.rect];
      engine.replaceExistingImage(
        state.currentPage,
        selectedImage.rect,
        targetRect,
        bytes
      );
      clearSelection();
      await commitAndRefresh('Reemplazar imagen original', { restoreKind: 'image-last' });
      return;
    }

    if (selectedImage?.kind === 'inserted-image') {
      const targetRect = [...selectedImage.rect];
      engine.replaceAnnotationImage(
        state.currentPage,
        selectedImage.annotationIndex,
        targetRect,
        bytes
      );
      clearSelection();
      await commitAndRefresh('Reemplazar imagen', { restoreKind: 'image-last' });
      return;
    }

    const dimensions = engine.getImageDimensions(bytes);
    state.pendingImage = { bytes, dimensions };
    const anchor = state.insertionAnchor;
    if (anchor) {
      hideInsertMenu({ preserveAnchor: true });
      await placePendingImage([anchor.x, anchor.y], anchor);
      state.insertionAnchor = null;
      return;
    }
    setTool('place-image');
    setStatus('Haz clic en la página para colocar la imagen.');
  } catch (error) {
    reportError(error);
  }
}

async function placePendingImage(point, anchor = null) {
  const pending = state.pendingImage;
  if (!pending) {
    return;
  }
  state.pendingImage = null;
  setTool('edit');
  const bounds = state.pageModel.bounds;
  const aspectRatio = pending.dimensions.height / Math.max(1, pending.dimensions.width);
  let width = anchor
    ? Math.min(Math.max(80, anchor.width), 240)
    : Math.min(180, Math.max(40, bounds[2] - point[0] - 18));
  let height = width * aspectRatio;
  if (!anchor && point[1] + height > bounds[3] - 18) {
    height = Math.max(30, bounds[3] - point[1] - 18);
    width = height / Math.max(0.01, aspectRatio);
  }
  engine.insertImageBlock(state.currentPage, [
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
    const block = state.pageModel.textBlocks.find((candidate) =>
      candidate.text.includes(prefix)
    );
    return block ? selectTextBlock(block.index) : false;
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
  setTextResizeMode(false);
  state.tool = tool;
  elements['text-layer']?.classList.toggle('placement-mode', tool !== 'edit');
  elements['insertion-layer']?.classList.toggle('disabled', tool !== 'edit');
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
    edit: 'Haz clic en un párrafo, selecciona cualquier texto o usa + para insertar.',
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
  elements['save-button'].addEventListener('click', () => {
    if (state.busy) {
      return;
    }
    setBusy(true, 'Guardando PDF…');
    postCommand('save');
  });

  elements['edit-text-tool'].addEventListener('click', () => {
    hideInsertMenu();
    setTool('edit');
    if (state.selected?.kind === 'text') {
      openExistingTextEditor(state.selected.block);
    }
  });
  elements['add-text-tool'].addEventListener('click', () => {
    hideInsertMenu();
    cancelBlockEditor();
    clearSelection();
    setTool('add-text');
    setStatus('Haz clic en cualquier punto de la página para escribir.');
  });
  elements['image-tool'].addEventListener('click', () => {
    hideInsertMenu();
    elements['image-file-input'].click();
  });
  elements['table-tool'].addEventListener('click', () => {
    hideInsertMenu();
    void chooseTableTool();
  });
  elements['delete-tool'].addEventListener('click', deleteSelection);
  elements['edit-content'].addEventListener('click', () => {
    if (state.selected?.kind === 'text') {
      openExistingTextEditor(state.selected.block);
    }
  });
  elements['resize-text-block'].addEventListener('click', activateTextResizeMode);
  elements['copy-text'].addEventListener('click', copySelectedText);
  elements['text-font-family'].addEventListener('change', textFormatChanged);
  elements['text-font-size'].addEventListener('change', textFormatChanged);
  elements['text-color'].addEventListener('change', textFormatChanged);
  elements['text-alignment'].addEventListener('change', textFormatChanged);
  elements['text-bold'].addEventListener('click', () => toggleFormatButton(elements['text-bold']));
  elements['text-italic'].addEventListener('click', () => toggleFormatButton(elements['text-italic']));
  elements['apply-table'].addEventListener('click', applyTableProperties);
  elements['edit-range-button'].addEventListener('click', openSelectedRangeEditor);
  elements['insert-text-here'].addEventListener('click', () => {
    const anchor = state.insertionAnchor;
    hideInsertMenu();
    if (anchor) {
      cancelBlockEditor();
      clearSelection();
      openNewTextEditor(anchor);
    }
  });
  elements['insert-image-here'].addEventListener('click', () => {
    elements['image-file-input'].click();
  });
  elements['insert-table-here'].addEventListener('click', () => {
    const anchor = state.insertionAnchor;
    if (anchor) {
      void chooseTableTool(anchor);
    }
  });
  elements['image-file-input'].addEventListener('change', handleImageFile);
  elements['block-editor-text'].addEventListener('input', syncEditingRectFromEditor);
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
  elements['page-stage'].addEventListener('pointerdown', (event) => {
    if (!elements['insert-menu'].contains(event.target) &&
        !event.target.closest?.('.insertion-marker')) {
      hideInsertMenu();
    }
    if (state.tool === 'edit' && state.selected?.kind === 'text' &&
        !event.target.closest?.('.text-layer-line, .edit-range-button, .block-editor')) {
      clearNativeTextSelection();
      clearSelection();
    }
  });
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
