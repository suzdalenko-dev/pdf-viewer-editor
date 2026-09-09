import { PdfEngine } from './pdf-engine.js';
import { base64ToBytes, clamp, transformPoint } from './utils.js';

const vscode = acquireVsCodeApi();
const engine = new PdfEngine();

const state = {
  fileName: 'document.pdf',
  currentPage: 0,
  pageCount: 0,
  zoom: 1,
  zoomMode: 'numeric',
  settings: {
    defaultZoom: 1,
    maxRenderPixels: 24_000_000
  },
  render: null,
  pageBounds: null,
  searchQuery: '',
  searchResults: [],
  searchIndex: -1,
  loadToken: 0,
  thumbnailToken: 0,
  thumbnailUrls: new Map(),
  busy: false,
  dialogRequest: null
};

const elements = Object.fromEntries([
  'app', 'toggle-pages', 'previous-page', 'next-page', 'page-number', 'page-count',
  'zoom-out', 'zoom-select', 'zoom-in', 'search-input', 'search-button',
  'pages-sidebar', 'thumbnail-list', 'page-viewport', 'page-stage', 'pdf-canvas',
  'search-layer', 'status-message', 'document-info', 'loading-overlay',
  'loading-message', 'dialog-backdrop', 'viewer-dialog', 'dialog-form',
  'dialog-title', 'dialog-content', 'dialog-cancel', 'dialog-confirm'
].map((id) => [id, document.getElementById(id)]));

window.addEventListener('message', async (event) => {
  const message = event.data;
  if (message.type === 'load-document') {
    await loadDocument(message);
  } else if (message.type === 'operation-error') {
    setBusy(false);
    setStatus(String(message.message || 'No se pudo abrir el PDF.'), 'error');
  }
});

initializeEventHandlers();
vscode.postMessage({ type: 'ready' });

async function loadDocument(message) {
  const token = ++state.loadToken;
  setBusy(true, 'Abriendo PDF…');
  revokeThumbnailUrls();

  try {
    if (typeof message.data !== 'string') {
      throw new Error('No se recibieron datos PDF válidos.');
    }

    state.fileName = String(message.fileName || 'document.pdf');
    state.settings = { ...state.settings, ...(message.settings || {}) };
    state.currentPage = 0;
    state.zoom = Number(state.settings.defaultZoom || 1);
    state.zoomMode = 'numeric';
    state.searchQuery = '';
    state.searchResults = [];
    state.searchIndex = -1;
    elements['search-input'].value = '';
    syncZoomControl();

    const bytes = base64ToBytes(message.data);
    let info = engine.load(bytes);
    while (info.passwordRequired) {
      const password = await requestPassword(Boolean(info.invalidPassword));
      if (password === null) {
        throw new Error('Se necesita una contraseña para abrir este PDF.');
      }
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
    await renderCurrentPage();
    void renderThumbnails();
    elements.app.setAttribute('aria-busy', 'false');
    setStatus('Solo lectura: el PDF original no se puede modificar.');
  } catch (error) {
    reportError(error);
  } finally {
    if (token === state.loadToken) {
      setBusy(false);
    }
  }
}

async function renderCurrentPage() {
  if (state.pageCount === 0) {
    return;
  }

  setBusy(true, `Renderizando página ${state.currentPage + 1}…`);
  try {
    state.pageBounds = engine.getPageBounds(state.currentPage);
    const scale = calculateRenderScale(state.pageBounds);
    state.render = engine.renderPage(
      state.currentPage,
      scale,
      Number(state.settings.maxRenderPixels)
    );
    drawRenderedPage();
    buildSearchLayer();
    updatePageControls();
    updateDocumentInfo();
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

function buildSearchLayer() {
  const layer = elements['search-layer'];
  layer.replaceChildren();
  layer.style.width = `${state.render.width}px`;
  layer.style.height = `${state.render.height}px`;

  state.searchResults.forEach((result, index) => {
    if (result.pageIndex !== state.currentPage) {
      return;
    }

    const screenRect = pdfRectToScreen(result.rect);
    const highlight = document.createElement('div');
    highlight.className = 'search-highlight';
    if (index === state.searchIndex) {
      highlight.classList.add('current');
    }
    highlight.style.left = `${screenRect[0]}px`;
    highlight.style.top = `${screenRect[1]}px`;
    highlight.style.width = `${Math.max(1, screenRect[2] - screenRect[0])}px`;
    highlight.style.height = `${Math.max(1, screenRect[3] - screenRect[1])}px`;
    layer.appendChild(highlight);
  });
}

function pdfRectToScreen(rect) {
  const first = transformPoint(state.render.pageToScreen, [rect[0], rect[1]]);
  const second = transformPoint(state.render.pageToScreen, [rect[2], rect[3]]);
  return [
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1])
  ];
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

  setBusy(true, 'Buscando en el documento…');
  try {
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
    state.currentPage = result.pageIndex;
    await renderCurrentPage();
    elements['page-viewport'].scrollTo({ top: 0, left: 0 });
    setStatus(`Resultado ${state.searchIndex + 1} de ${state.searchResults.length}.`);
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
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
    button.title = `Ir a la página ${pageIndex + 1}`;

    const image = document.createElement('img');
    image.alt = `Miniatura de la página ${pageIndex + 1}`;
    const label = document.createElement('span');
    label.textContent = String(pageIndex + 1);
    button.append(image, label);
    button.addEventListener('click', () => goToPage(pageIndex));
    elements['thumbnail-list'].appendChild(button);

    try {
      const bytes = engine.renderThumbnail(pageIndex, 142);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      state.thumbnailUrls.set(pageIndex, url);
      image.src = url;
    } catch (error) {
      button.title = error instanceof Error ? error.message : String(error);
    }

    // Yield between pages so large documents keep the viewer responsive and a
    // replacement document can cancel the remaining thumbnail work.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  updateThumbnailSelection();
}

function revokeThumbnailUrls() {
  state.thumbnailToken += 1;
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
  if (target === state.currentPage && state.render) {
    return;
  }

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
  const width = Math.round(state.pageBounds[2] - state.pageBounds[0]);
  const height = Math.round(state.pageBounds[3] - state.pageBounds[1]);
  elements['document-info'].textContent = `${state.fileName} · ${width} × ${height} pt`;
}

async function changeZoom(delta) {
  state.zoomMode = 'numeric';
  state.zoom = clamp((state.render?.scale || state.zoom) + delta, 0.25, 5);
  syncZoomControl();
  await renderCurrentPage();
}

function syncZoomControl() {
  if (state.zoomMode === 'fit' || state.zoomMode === 'width') {
    elements['zoom-select'].value = state.zoomMode;
    return;
  }

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
  elements['search-input'].addEventListener('input', () => {
    if (!elements['search-input'].value.trim() && state.searchResults.length > 0) {
      state.searchQuery = '';
      state.searchResults = [];
      state.searchIndex = -1;
      buildSearchLayer();
      setStatus('Solo lectura: el PDF original no se puede modificar.');
    }
  });
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

  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (modifier && key === 'f') {
    event.preventDefault();
    elements['search-input'].focus();
    elements['search-input'].select();
  } else if (modifier && key === 's') {
    event.preventDefault();
    setStatus('Solo lectura: guardar y guardar como están deshabilitados.');
  } else if (modifier && ['z', 'y'].includes(key) && !isFormControl(event.target)) {
    event.preventDefault();
    setStatus('Solo lectura: deshacer y rehacer no son aplicables.');
  } else if (event.key === 'PageUp' && !isFormControl(event.target)) {
    event.preventDefault();
    void goToPage(state.currentPage - 1);
  } else if (event.key === 'PageDown' && !isFormControl(event.target)) {
    event.preventDefault();
    void goToPage(state.currentPage + 1);
  }
}

function isFormControl(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
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
  for (const field of options.fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement('input');
    input.name = field.name;
    input.type = field.type || 'text';
    input.value = field.value || '';
    input.required = Boolean(field.required);
    if (field.autocomplete) {
      input.autocomplete = field.autocomplete;
    }
    label.appendChild(input);
    fieldContainer.appendChild(label);
  }
  elements['dialog-content'].appendChild(fieldContainer);
  elements['dialog-backdrop'].classList.remove('hidden');
  elements['viewer-dialog'].setAttribute('open', '');
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
  elements['viewer-dialog'].removeAttribute('open');
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
