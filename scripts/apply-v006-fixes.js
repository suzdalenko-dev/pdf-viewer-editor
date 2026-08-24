'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected one match, found ${count}`);
  }
  return source.replace(before, after);
}

function replaceRegexOnce(source, regex, after, label) {
  const matches = source.match(regex);
  if (!matches) {
    throw new Error(`${label}: no match`);
  }
  return source.replace(regex, after);
}

// --- main.js ---------------------------------------------------------------
const mainPath = 'media/webview/main.js';
let main = fs.readFileSync(mainPath, 'utf8');

main = replaceOnce(
  main,
  "  'text-context', 'edit-content', 'copy-text', 'text-font-family', 'text-font-size',",
  "  'text-context', 'edit-content', 'resize-text-block', 'copy-text', 'text-font-family', 'text-font-size',",
  'register resize text button'
);

main = replaceOnce(
  main,
`      preserveObjectStacking: true,
      selection: false,
      stopContextMenu: true`,
`      preserveObjectStacking: true,
      selection: false,
      enableRetinaScaling: false,
      stopContextMenu: true`,
  'disable Fabric retina scaling'
);

main = replaceOnce(
  main,
`  if (!options.preserveRange) {
    state.textRange = null;
    hideEditRangeButton();
  }`,
`  if (!options.preserveRange) {
    state.textRange = null;
    hideEditRangeButton();
    clearTextRangeHighlights();
  }`,
  'clear custom selection highlight'
);

main = replaceOnce(
  main,
`  state.textRange = {
    blockIndex: block.index,
    start: start.offset,
    end: end.offset,
    text: block.text.slice(start.offset, end.offset)
  };
  selectTextBlock(block.index, { preserveRange: true });`,
`  state.textRange = {
    blockIndex: block.index,
    start: start.offset,
    end: end.offset,
    text: block.text.slice(start.offset, end.offset)
  };
  renderTextRangeHighlights();
  selectTextBlock(block.index, { preserveRange: true });`,
  'render precise text selection'
);

main = replaceOnce(
  main,
`function hideEditRangeButton() {
  elements['edit-range-button'].classList.add('hidden');
}
`,
`function hideEditRangeButton() {
  elements['edit-range-button'].classList.add('hidden');
}

function clearTextRangeHighlights() {
  for (const highlight of elements['text-layer'].querySelectorAll('.text-range-highlight')) {
    highlight.remove();
  }
}

function renderTextRangeHighlights() {
  clearTextRangeHighlights();
  const selectedRange = state.textRange;
  if (!selectedRange || !state.pageModel) {
    return;
  }

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

    let rect = null;
    const characters = Array.isArray(line.characters) ? line.characters : [];
    const selectedCharacters = characters.slice(localStart, localEnd)
      .map((character) => character.rect)
      .filter((candidate) => Array.isArray(candidate) && candidate.length === 4);

    if (selectedCharacters.length > 0) {
      rect = selectedCharacters.reduce((result, candidate) => result
        ? [
            Math.min(result[0], candidate[0]),
            Math.min(result[1], candidate[1]),
            Math.max(result[2], candidate[2]),
            Math.max(result[3], candidate[3])
          ]
        : [...candidate], null);
    } else {
      const lineWidth = Math.max(1, line.rect[2] - line.rect[0]);
      const startRatio = localStart / Math.max(1, line.text.length);
      const endRatio = localEnd / Math.max(1, line.text.length);
      rect = [
        line.rect[0] + lineWidth * startRatio,
        line.rect[1],
        line.rect[0] + lineWidth * endRatio,
        line.rect[3]
      ];
    }

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

  setTextResizeMode(true);
  const resizeMeta = {
    ...selected,
    resizeMode: true
  };
  const object = addOverlayObject(resizeMeta, {
    stroke: '#1473e6',
    fill: 'rgba(20, 115, 230, 0.025)',
    movable: true,
    resizable: true
  });
  state.fabricCanvas.setActiveObject(object);
  object.set('stroke', object.editorStroke);
  state.fabricCanvas.requestRenderAll();
  setStatus('Arrastra el marco para mover el texto o sus esquinas para cambiar la anchura; al soltar se recompone el texto.');
}
`,
  'selection highlight and text resize helpers'
);

main = replaceOnce(
  main,
`function clearSelection() {
  state.selected = null;
  state.textRange = null;
  hideEditRangeButton();
  clearTextLineHighlights();`,
`function clearSelection() {
  state.selected = null;
  state.textRange = null;
  hideEditRangeButton();
  clearTextRangeHighlights();
  setTextResizeMode(false);
  clearTextLineHighlights();`,
  'clear selection state'
);

main = replaceOnce(
  main,
`function objectScreenRectToPdf(object) {
  const width = Math.max(2, object.width * object.scaleX);
  const height = Math.max(2, object.height * object.scaleY);
  return screenRectToPdf([
    object.left,
    object.top,
    object.left + width,
    object.top + height
  ]);
}`,
`function objectScreenRectToPdf(object) {
  // Fabric's getBoundingRect() returns the actual scene rectangle after scale,
  // controls and origin transforms. Using left/top + width*scale caused the
  // editor frame to drift away from the rendered PDF object.
  const bounds = object.getBoundingRect();
  return screenRectToPdf([
    bounds.left,
    bounds.top,
    bounds.left + Math.max(2, bounds.width),
    bounds.top + Math.max(2, bounds.height)
  ]);
}`,
  'precise Fabric geometry conversion'
);

main = replaceOnce(
  main,
`    } else if (meta.kind === 'table') {
      engine.updateTable(`,
`    } else if (meta.kind === 'text' && meta.resizeMode) {
      setTextResizeMode(false);
      engine.resizeTextBlock(state.currentPage, meta.blockIndex, targetRect);
      await commitAndRefresh('Mover o redimensionar texto', {
        restoreText: meta.block.text
      });
    } else if (meta.kind === 'table') {
      engine.updateTable(`,
  'handle text resize modification'
);

main = replaceOnce(
  main,
`  elements['edit-content'].addEventListener('click', () => {
    if (state.selected?.kind === 'text') {
      openExistingTextEditor(state.selected.block);
    }
  });
  elements['copy-text'].addEventListener('click', copySelectedText);`,
`  elements['edit-content'].addEventListener('click', () => {
    if (state.selected?.kind === 'text') {
      openExistingTextEditor(state.selected.block);
    }
  });
  elements['resize-text-block'].addEventListener('click', activateTextResizeMode);
  elements['copy-text'].addEventListener('click', copySelectedText);`,
  'resize button handler'
);

fs.writeFileSync(mainPath, main);

// --- pdf-engine.js ----------------------------------------------------------
const enginePath = 'media/webview/pdf-engine.js';
let engine = fs.readFileSync(enginePath, 'utf8');

engine = replaceOnce(
  engine,
`      currentLine = {
        text: '',
        rect: normalizeRect([...bbox]),
        baseline: null,
        styles: new Map()
      };`,
`      currentLine = {
        text: '',
        rect: normalizeRect([...bbox]),
        baseline: null,
        styles: new Map(),
        characters: []
      };`,
  'capture character boxes init'
);

engine = replaceOnce(
  engine,
`        currentLine.text += String(character);
        currentLine.baseline ||= [Number(origin[0] || 0), Number(origin[1] || 0)];
        currentLine.rect = unionRects([
          currentLine.rect,
          quadToRect(quad)
        ]);`,
`        const characterText = String(character);
        const characterRect = quadToRect(quad);
        currentLine.text += characterText;
        currentLine.characters.push({ text: characterText, rect: characterRect });
        currentLine.baseline ||= [Number(origin[0] || 0), Number(origin[1] || 0)];
        currentLine.rect = unionRects([
          currentLine.rect,
          characterRect
        ]);`,
  'capture character boxes'
);

engine = replaceOnce(
  engine,
`        baseline: currentLine.baseline || [currentLine.rect[0], currentLine.rect[3]],
        font: style.font,
        color: style.color`,
`        baseline: currentLine.baseline || [currentLine.rect[0], currentLine.rect[3]],
        font: style.font,
        color: style.color,
        characters: currentLine.characters`,
  'expose line character boxes'
);

engine = replaceOnce(
  engine,
`    let text = '';
    let previous = null;
    for (const fragment of row.fragments) {
      if (previous && needsVisualSpace(previous, fragment)) {
        text += ' ';
      }
      text += fragment.text;
      previous = fragment;
    }
    const style = dominantLineStyle(row.fragments);
    return {
      text,
      fragments: row.fragments,
      rect: row.rect,
      baseline: [row.fragments[0].baseline[0], row.baseline[1]],
      font: style.font,
      color: style.color
    };`,
`    let text = '';
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
    };`,
  'propagate visual character boxes'
);

engine = replaceOnce(
  engine,
`  moveTextBlock(pageIndex, blockIndex, targetRect) {
    const model = this.getPageModel(pageIndex);`,
`  resizeTextBlock(pageIndex, blockIndex, targetRect) {
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
    const model = this.getPageModel(pageIndex);`,
  'add resizeTextBlock method'
);

fs.writeFileSync(enginePath, engine);

// --- HTML ------------------------------------------------------------------
const htmlPath = 'src/webview-html.js';
let html = fs.readFileSync(htmlPath, 'utf8');
html = replaceOnce(
  html,
`        <button id="edit-content" class="primary-button">Editar contenido</button>
        <button id="copy-text">Copiar</button>`,
`        <button id="edit-content" class="primary-button">Editar contenido</button>
        <button id="resize-text-block">Mover / redimensionar</button>
        <button id="copy-text">Copiar</button>`,
  'add text resize button'
);
fs.writeFileSync(htmlPath, html);

// --- CSS -------------------------------------------------------------------
const cssPath = 'media/webview/styles.css';
let css = fs.readFileSync(cssPath, 'utf8');
css = replaceOnce(
  css,
`.text-layer-line::selection {
  color: transparent;
  background: color-mix(in srgb, var(--focus) 38%, transparent);
}
`,
`.text-layer-line::selection {
  color: transparent;
  background: transparent;
}

.text-range-highlight {
  position: absolute;
  z-index: -1;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--focus) 82%, transparent);
  border-radius: 1px;
  background: color-mix(in srgb, var(--focus) 28%, transparent);
  pointer-events: none;
}

.text-layer.resize-mode {
  pointer-events: none;
}

.text-layer.resize-mode .text-layer-line {
  pointer-events: none;
  user-select: none;
}

.insertion-layer.resize-mode {
  pointer-events: none;
}
`,
  'precise selection styles'
);
fs.writeFileSync(cssPath, css);

// --- package metadata -------------------------------------------------------
const packagePath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = '0.0.6';
pkg.icon = 'images/icon.png';
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const lockPath = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (lock.packages?.['']) {
  lock.packages[''].version = '0.0.6';
}
if (lock.version) {
  lock.version = '0.0.6';
}
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

// --- regression contract ---------------------------------------------------
const testPath = 'test/ui-contract.test.mjs';
let test = fs.readFileSync(testPath, 'utf8');
test = test.replace("assert.equal(pkg.version, '0.0.5');", "assert.equal(pkg.version, '0.0.6');");
test += `\n\ntest('v0.0.6 keeps overlays in one coordinate system and supports text resizing', () => {\n  assert.match(main, /enableRetinaScaling: false/);\n  assert.match(main, /object\\.getBoundingRect\\(\\)/);\n  assert.match(main, /resize-text-block/);\n  assert.match(main, /engine\\.resizeTextBlock/);\n});\n\ntest('v0.0.6 renders text selection from extracted PDF character rectangles', () => {\n  const engine = fs.readFileSync(new URL('../media/webview/pdf-engine.js', import.meta.url), 'utf8');\n  assert.match(engine, /characters: currentLine\\.characters/);\n  assert.match(main, /text-range-highlight/);\n  assert.match(main, /selectedCharacters/);\n});\n`;
fs.writeFileSync(testPath, test);

// changelog
const changelogPath = 'CHANGELOG.md';
let changelog = fs.readFileSync(changelogPath, 'utf8');
if (!changelog.includes('## 0.0.6 - 2026-08-24')) {
  const marker = 'Todos los cambios relevantes de este proyecto se documentan aquí.\n';
  const section = `\n## 0.0.6 - 2026-08-24\n\n### Corregido\n\n- La selección visual se calcula con los rectángulos reales de caracteres extraídos del PDF.\n- Capa Fabric y página usan el mismo sistema de coordenadas, evitando desplazamientos de tablas y marcos.\n- Las tablas mantienen el marco de edición alineado al objeto real.\n- Los bloques de texto se pueden mover y redimensionar; al cambiar su anchura el texto se recompone y desplaza el contenido inferior.\n- Se conserva el icono de Marketplace y la extensión se empaqueta como 0.0.6.\n\n`;
  changelog = changelog.replace(marker, marker + section);
}
fs.writeFileSync(changelogPath, changelog);

console.log('v0.0.6 geometry and resize fixes applied.');
