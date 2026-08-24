'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  return source.replace(before, after);
}

function replaceRegex(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  if (!matches) {
    throw new Error(`${label}: pattern not found`);
  }
  return source.replace(pattern, replacement);
}

// --- Release metadata -------------------------------------------------------
const packagePath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = '0.0.6';
pkg.icon = 'images/icon.png';
pkg.contributes.configuration.properties['pdfViewerEditor.defaultZoom'].default = 1;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const lockPath = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
lock.version = '0.0.6';
if (lock.packages?.['']) {
  lock.packages[''].version = '0.0.6';
}
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

// --- PDF engine: tight glyph geometry, resizable text, exact table rect ----
const enginePath = 'media/webview/pdf-engine.js';
let engine = fs.readFileSync(enginePath, 'utf8');

engine = replaceRegex(
  engine,
  /  readAnnotations\(page\) \{[\s\S]*?\n  \}\n\n  readWidgets\(page\) \{/,
`  readAnnotations(page) {
    const annotations = page.getAnnotations();
    return annotations.map((annotation, index) => {
      try {
        const type = annotation.getType();
        const contents = safeCall(() => annotation.getContents(), '');
        const subject = safeCall(() => annotation.getSubject(), '');
        const table = parseTableMetadata(type, subject, contents);
        const annotationRect = annotation.hasRect()
          ? [...annotation.getRect()]
          : [...annotation.getBounds()];
        const inkRect = table
          ? rectFromInkStrokes(safeCall(() => annotation.getInkList(), []), table.rect || annotationRect)
          : annotationRect;
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
          rect: normalizeRect(inkRect),
          contents,
          author: safeCall(() => annotation.getAuthor(), ''),
          subject,
          table,
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

  readWidgets(page) {`,
  'readAnnotations'
);

engine = replaceOnce(
  engine,
`    beginLine(bbox) {
      currentLine = {
        text: '',
        rect: normalizeRect([...bbox]),
        baseline: null,
        styles: new Map()
      };
    },`,
`    beginLine(bbox) {
      currentLine = {
        text: '',
        sourceRect: normalizeRect([...bbox]),
        rect: null,
        baseline: null,
        styles: new Map(),
        characters: []
      };
    },`,
  'tight line initialization'
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
        const characterRect = normalizeRect(quadToRect(quad));
        currentLine.text += characterText;
        currentLine.characters.push({
          text: characterText,
          rect: characterRect
        });
        currentLine.baseline ||= [Number(origin[0] || 0), Number(origin[1] || 0)];
        currentLine.rect = currentLine.rect
          ? unionRects([currentLine.rect, characterRect])
          : [...characterRect];`,
  'character quad capture'
);

engine = replaceOnce(
  engine,
`      const style = dominantWeightedStyle(currentLine.styles);
      currentBlock.lines.push({
        text: currentLine.text,
        rect: currentLine.rect,
        baseline: currentLine.baseline || [currentLine.rect[0], currentLine.rect[3]],
        font: style.font,
        color: style.color
      });`,
`      const style = dominantWeightedStyle(currentLine.styles);
      const tightRect = currentLine.rect || currentLine.sourceRect;
      currentBlock.lines.push({
        text: currentLine.text,
        rect: tightRect,
        baseline: currentLine.baseline || [tightRect[0], tightRect[3]],
        font: style.font,
        color: style.color,
        characters: currentLine.characters
      });`,
  'tight line finalization'
);

engine = replaceRegex(
  engine,
  /function buildVisualLines\(lines\) \{[\s\S]*?\n\}\n\nfunction needsVisualSpace/,
`function buildVisualLines(lines) {
  const sortedLines = [...lines].sort((left, right) => {
    const yDifference = left.baseline[1] - right.baseline[1];
    return Math.abs(yDifference) > 0.75
      ? yDifference
      : left.rect[0] - right.rect[0];
  });
  const rows = [];
  for (const line of sortedLines) {
    const tolerance = Math.max(1, line.font.size * 0.2);
    const row = rows.findLast((candidate) =>
      Math.abs(candidate.baseline[1] - line.baseline[1]) <= tolerance
    );
    if (row) {
      row.fragments.push(line);
      row.rect = unionRects([row.rect, line.rect]);
    } else {
      rows.push({
        fragments: [line],
        rect: [...line.rect],
        baseline: [...line.baseline]
      });
    }
  }

  return rows.map((row) => {
    row.fragments.sort((left, right) => left.rect[0] - right.rect[0]);
    let text = '';
    let offset = 0;
    let previous = null;
    const characters = [];
    for (const fragment of row.fragments) {
      if (previous && needsVisualSpace(previous, fragment)) {
        const spaceRect = normalizeRect([
          previous.rect[2],
          Math.min(previous.rect[1], fragment.rect[1]),
          fragment.rect[0],
          Math.max(previous.rect[3], fragment.rect[3])
        ]);
        characters.push({ text: ' ', rect: spaceRect, start: offset, end: offset + 1 });
        text += ' ';
        offset += 1;
      }
      for (const character of fragment.characters || []) {
        const characterText = String(character.text || '');
        const start = offset;
        offset += characterText.length;
        characters.push({
          text: characterText,
          rect: [...character.rect],
          start,
          end: offset
        });
      }
      text += fragment.text;
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
    };
  });
}

function needsVisualSpace`,
  'visual line character geometry'
);

engine = replaceRegex(
  engine,
  /function decorateParagraphLines\(paragraphLines, blockIndex\) \{[\s\S]*?\n\}\n\nfunction layoutRichTextBlock/,
`function decorateParagraphLines(paragraphLines, blockIndex) {
  let text = '';
  const lines = [];

  for (const sourceLine of paragraphLines) {
    const rawText = String(sourceLine.text || '');
    const lineText = rawText.trim();
    if (!lineText) {
      continue;
    }
    const leadingTrim = rawText.length - rawText.trimStart().length;
    const rawEnd = leadingTrim + lineText.length;
    const separator = text ? ' ' : '';
    const start = text.length + separator.length;
    text += separator + lineText;
    const end = text.length;
    const lineIndex = lines.length;
    const characters = (sourceLine.characters || [])
      .filter((character) => character.end > leadingTrim && character.start < rawEnd)
      .map((character) => ({
        ...character,
        start: start + Math.max(0, character.start - leadingTrim),
        end: start + Math.min(lineText.length, character.end - leadingTrim)
      }));
    lines.push({
      ...sourceLine,
      text: lineText,
      characters,
      blockIndex,
      lineIndex,
      start,
      end,
      startOffset: start,
      endOffset: end,
      textStart: start,
      textEnd: end
    });
  }

  return { text, lines };
}

function layoutRichTextBlock`,
  'paragraph character offsets'
);

engine = replaceOnce(
  engine,
  '  editTextBlock(pageIndex, blockIndex, properties = {}) {',
  '  editTextBlock(pageIndex, blockIndex, properties = {}, targetRect = null) {',
  'editTextBlock signature'
);
engine = replaceOnce(
  engine,
`    const values = normalizeBlockProperties(block, properties);
    const layout = layoutTextBlock(block.rect, values, block.metrics, block);`,
`    const values = normalizeBlockProperties(block, properties);
    const layoutRect = textLayoutRect(block.rect, targetRect);
    const layout = layoutTextBlock(layoutRect, values, block.metrics, block);`,
  'editTextBlock layout rect'
);
engine = replaceOnce(
  engine,
`      rect: [block.rect[0], block.rect[1], block.rect[2], block.rect[1] + layout.height]
    };
  }

  /**
   * Replaces an arbitrary character range`,
`      rect: [layoutRect[0], block.rect[1], layoutRect[2], block.rect[1] + layout.height]
    };
  }

  /**
   * Replaces an arbitrary character range`,
  'editTextBlock result rect'
);

engine = replaceOnce(
  engine,
  '  editTextRange(pageIndex, blockIndex, start, end, replacement, properties = {}) {',
  '  editTextRange(pageIndex, blockIndex, start, end, replacement, properties = {}, targetRect = null) {',
  'editTextRange signature'
);
engine = replaceOnce(
  engine,
`    const resultingText = runs.map((run) => run.text).join('');
    const layout = layoutRichTextBlock(
      block.rect,`,
`    const resultingText = runs.map((run) => run.text).join('');
    const layoutRect = textLayoutRect(block.rect, targetRect);
    const layout = layoutRichTextBlock(
      layoutRect,`,
  'editTextRange layout rect'
);
engine = replaceOnce(
  engine,
`      rect: [block.rect[0], block.rect[1], block.rect[2], block.rect[1] + layout.height]
    };
  }

  /**
   * Inserts a new static text block`,
`      rect: [layoutRect[0], block.rect[1], layoutRect[2], block.rect[1] + layout.height]
    };
  }

  /**
   * Inserts a new static text block`,
  'editTextRange result rect'
);

engine = replaceOnce(
  engine,
`      annotation.setContents(JSON.stringify({
        type: 'table',
        rows: rowCount,
        columns: columnCount,
        color,
        borderWidth
      }));`,
`      annotation.setContents(JSON.stringify({
        type: 'table',
        rows: rowCount,
        columns: columnCount,
        color,
        borderWidth,
        rect: normalizedRect
      }));`,
  'table logical rect metadata'
);

engine = replaceOnce(
  engine,
`function defaultTextMetrics(fontSize) {
  const size = Math.max(1, Number(fontSize || 12));`,
`function textLayoutRect(originalRect, targetRect) {
  const original = normalizeRect(originalRect);
  if (!Array.isArray(targetRect) || targetRect.length !== 4) {
    return [...original];
  }
  const target = normalizeRect(targetRect);
  const minimumWidth = 24;
  return [
    target[0],
    original[1],
    Math.max(target[0] + minimumWidth, target[2]),
    original[3]
  ];
}

function defaultTextMetrics(fontSize) {
  const size = Math.max(1, Number(fontSize || 12));`,
  'text layout rect helper'
);

engine = replaceOnce(
  engine,
`    return {
      rows: Math.max(1, Math.min(30, Math.round(Number(value.rows) || 2))),
      columns: Math.max(1, Math.min(20, Math.round(Number(value.columns) || 2))),
      color: normalizeColor(value.color, [0, 0, 0]),
      borderWidth: Math.max(0.25, Math.min(8, Number(value.borderWidth || 1)))
    };`,
`    return {
      rows: Math.max(1, Math.min(30, Math.round(Number(value.rows) || 2))),
      columns: Math.max(1, Math.min(20, Math.round(Number(value.columns) || 2))),
      color: normalizeColor(value.color, [0, 0, 0]),
      borderWidth: Math.max(0.25, Math.min(8, Number(value.borderWidth || 1))),
      rect: Array.isArray(value.rect) && value.rect.length === 4
        ? normalizeRect(value.rect.map(Number))
        : null
    };`,
  'table metadata rect parsing'
);

engine = replaceOnce(
  engine,
`function textMatrixForPage(transform, baseline) {`,
`function rectFromInkStrokes(strokes, fallback) {
  const points = [];
  for (const stroke of Array.isArray(strokes) ? strokes : []) {
    for (const point of Array.isArray(stroke) ? stroke : []) {
      if (Array.isArray(point) && point.length >= 2 &&
          Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) {
        points.push([Number(point[0]), Number(point[1])]);
      }
    }
  }
  if (points.length === 0) {
    return normalizeRect(fallback);
  }
  return [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1]))
  ];
}

function textMatrixForPage(transform, baseline) {`,
  'ink rect helper'
);

fs.writeFileSync(enginePath, engine);

// --- Webview HTML -----------------------------------------------------------
const htmlPath = 'src/webview-html.js';
let html = fs.readFileSync(htmlPath, 'utf8');
html = replaceOnce(
  html,
  '          <div id="text-layer" class="text-layer" aria-label="Texto seleccionable del PDF"></div>\n          <canvas id="editor-canvas" aria-label="Capa de edición del PDF"></canvas>',
  '          <div id="selection-layer" class="selection-layer" aria-hidden="true"></div>\n          <div id="text-layer" class="text-layer" aria-label="Texto seleccionable del PDF"></div>\n          <canvas id="editor-canvas" aria-label="Capa de edición del PDF"></canvas>',
  'selection layer HTML'
);
fs.writeFileSync(htmlPath, html);

// --- Webview JS -------------------------------------------------------------
const mainPath = 'media/webview/main.js';
let main = fs.readFileSync(mainPath, 'utf8');
main = replaceOnce(
  main,
  "  'page-viewport', 'page-stage', 'pdf-canvas', 'text-layer', 'editor-canvas',",
  "  'page-viewport', 'page-stage', 'pdf-canvas', 'selection-layer', 'text-layer', 'editor-canvas',",
  'selection layer element binding'
);

main = replaceRegex(
  main,
  /function buildTextLayer\(\) \{[\s\S]*?\n\}\n\nfunction textLineClicked/,
`function buildTextLayer() {
  const layer = elements['text-layer'];
  const selectionLayer = elements['selection-layer'];
  layer.replaceChildren();
  selectionLayer.replaceChildren();
  layer.style.width = \`${'${state.render.width}'}px\`;
  layer.style.height = \`${'${state.render.height}'}px\`;
  selectionLayer.style.width = \`${'${state.render.width}'}px\`;
  selectionLayer.style.height = \`${'${state.render.height}'}px\`;
  layer.classList.toggle('disabled', state.tool !== 'edit');
  layer.classList.toggle('placement-mode', state.tool !== 'edit');

  for (const line of state.pageModel.textLines) {
    const screen = pdfRectToScreen(line.rect);
    const targetWidth = Math.max(1, screen[2] - screen[0]);
    const targetHeight = Math.max(1, screen[3] - screen[1]);
    const item = document.createElement('span');
    item.className = 'text-layer-line';
    item.textContent = line.text;
    item.dataset.blockIndex = String(line.blockIndex);
    item.dataset.lineIndex = String(line.lineIndex);
    item.dataset.textStart = String(line.textStart);
    item.dataset.textEnd = String(line.textEnd);
    item.title = 'Haz clic para seleccionar la línea; arrastra para seleccionar texto';
    item.style.left = \`${'${screen[0]}'}px\`;
    item.style.top = \`${'${screen[1]}'}px\`;
    item.style.width = 'max-content';
    item.style.height = \`${'${targetHeight}'}px\`;
    item.style.fontSize = \`${'${Math.max(4, line.font.size * state.render.scale)}'}px\`;
    item.style.lineHeight = \`${'${targetHeight}'}px\`;
    item.style.fontFamily = line.font.family;
    item.style.fontWeight = line.font.weight;
    item.style.fontStyle = line.font.style;
    item.addEventListener('click', textLineClicked);
    item.addEventListener('dblclick', () => window.requestAnimationFrame(updateTextRangeFromSelection));
    layer.appendChild(item);

    const naturalWidth = Math.max(1, item.getBoundingClientRect().width);
    item.style.transform = \`scaleX(${'${targetWidth / naturalWidth}'})\`;
  }
}

function textLineClicked`,
  'precise text layer layout'
);

main = replaceRegex(
  main,
  /function updateTextRangeFromSelection\(\) \{[\s\S]*?\n\}\n\nfunction selectionInsideTextLayer/,
`function updateTextRangeFromSelection() {
  if (state.busy || state.editing) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selectionInsideTextLayer(selection)) {
    state.textRange = null;
    clearTextSelectionOverlay();
    hideEditRangeButton();
    return;
  }
  const range = selection.getRangeAt(0);
  const start = selectionEndpointToTextOffset(range.startContainer, range.startOffset);
  const end = selectionEndpointToTextOffset(range.endContainer, range.endOffset);
  if (!start || !end || start.blockIndex !== end.blockIndex || end.offset <= start.offset) {
    state.textRange = null;
    clearTextSelectionOverlay();
    hideEditRangeButton();
    setStatus('Para editar, selecciona texto dentro de un mismo párrafo.');
    return;
  }
  const block = state.pageModel.textBlocks.find((candidate) =>
    candidate.index === start.blockIndex
  );
  if (!block) {
    clearTextSelectionOverlay();
    return;
  }
  state.textRange = {
    blockIndex: block.index,
    start: start.offset,
    end: end.offset,
    text: block.text.slice(start.offset, end.offset)
  };
  selectTextBlock(block.index, { preserveRange: true });
  const selectedRects = renderTextSelection(block, start.offset, end.offset);
  showEditRangeButton(selectedRects);
  setStatus('Texto seleccionado: pulsa “Editar selección”, cambia su formato o elimínalo.');
}

function selectionInsideTextLayer`,
  'exact selection overlay flow'
);

main = replaceRegex(
  main,
  /function showEditRangeButton\(range\) \{[\s\S]*?\n\}\n\nfunction hideEditRangeButton/,
`function showEditRangeButton(pdfRects) {
  if (!Array.isArray(pdfRects) || pdfRects.length === 0) {
    hideEditRangeButton();
    return;
  }
  const screenRects = pdfRects.map(pdfRectToScreen);
  const selectionRect = unionScreenRects(screenRects);
  const button = elements['edit-range-button'];
  const width = 126;
  button.style.left = \`${'${clamp(selectionRect[0] + (selectionRect[2] - selectionRect[0]) / 2 - width / 2, 4, Math.max(4, state.render.width - width - 4))}'}px\`;
  button.style.top = \`${'${clamp(selectionRect[3] + 5, 4, Math.max(4, state.render.height - 34))}'}px\`;
  button.classList.remove('hidden');
}

function hideEditRangeButton`,
  'selection button exact position'
);

main = replaceOnce(
  main,
`function clearTextLineHighlights() {
  for (const line of elements['text-layer'].querySelectorAll('.text-layer-line.selected')) {
    line.classList.remove('selected');
  }
}

function clearNativeTextSelection() {`,
`function clearTextLineHighlights() {
  for (const line of elements['text-layer'].querySelectorAll('.text-layer-line.selected')) {
    line.classList.remove('selected');
  }
}

function clearTextSelectionOverlay() {
  elements['selection-layer']?.replaceChildren();
}

function renderTextSelection(block, start, end) {
  const layer = elements['selection-layer'];
  layer.replaceChildren();
  const rects = [];
  for (const line of block.visualLines || []) {
    const selectedCharacters = (line.characters || []).filter((character) =>
      character.end > start && character.start < end
    );
    if (selectedCharacters.length === 0) {
      continue;
    }
    const rect = unionPdfRects(selectedCharacters.map((character) => character.rect));
    rects.push(rect);
    const screen = pdfRectToScreen(rect);
    const highlight = document.createElement('div');
    highlight.className = 'selection-highlight';
    highlight.style.left = \`${'${screen[0]}'}px\`;
    highlight.style.top = \`${'${screen[1]}'}px\`;
    highlight.style.width = \`${'${Math.max(1, screen[2] - screen[0])}'}px\`;
    highlight.style.height = \`${'${Math.max(1, screen[3] - screen[1])}'}px\`;
    layer.appendChild(highlight);
  }
  return rects;
}

function unionPdfRects(rects) {
  if (!rects.length) {
    return [0, 0, 0, 0];
  }
  return [
    Math.min(...rects.map((rect) => rect[0])),
    Math.min(...rects.map((rect) => rect[1])),
    Math.max(...rects.map((rect) => rect[2])),
    Math.max(...rects.map((rect) => rect[3]))
  ];
}

function unionScreenRects(rects) {
  return unionPdfRects(rects);
}

function clearNativeTextSelection() {`,
  'custom selection helpers'
);

main = replaceOnce(
  main,
`  state.selected = null;
  state.textRange = null;
  hideEditRangeButton();
  clearTextLineHighlights();`,
`  state.selected = null;
  state.textRange = null;
  hideEditRangeButton();
  clearTextLineHighlights();
  clearTextSelectionOverlay();`,
  'clear selection overlay'
);

main = replaceOnce(
  main,
`    hasRotatingPoint: false,
    lockRotation: true,
    selectable: options.selectable !== false,`,
`    hasRotatingPoint: false,
    lockRotation: true,
    originX: 'left',
    originY: 'top',
    strokeUniform: true,
    lockScalingFlip: true,
    centeredScaling: false,
    selectable: options.selectable !== false,`,
  'fabric exact geometry options'
);

main = replaceOnce(
  main,
`  editor.style.left = \`${'${clamp(screen[0], 0, Math.max(0, state.render.width - 190))}'}px\`;
  editor.style.top = \`${'${clamp(screen[1], 0, Math.max(0, state.render.height - 90))}'}px\`;
  editor.style.width = \`${'${Math.max(180, Math.min(state.render.width, screen[2] - screen[0]))}'}px\`;`,
`  const editorLeft = clamp(screen[0], 0, Math.max(0, state.render.width - 80));
  editor.style.left = \`${'${editorLeft}'}px\`;
  editor.style.top = \`${'${clamp(screen[1], 0, Math.max(0, state.render.height - 50))}'}px\`;
  editor.style.width = \`${'${Math.max(80, Math.min(state.render.width - editorLeft, screen[2] - screen[0]))}'}px\`;
  editor.style.height = 'auto';`,
  'text editor tight width'
);

main = replaceOnce(
  main,
  "  textarea.style.height = `${clamp(textarea.scrollHeight + 4, 64, 420)}px`;",
  "  textarea.style.height = `${clamp(textarea.scrollHeight + 2, 28, 420)}px`;",
  'text editor tight height'
);

main = replaceOnce(
  main,
`async function applyBlockEditor() {
  if (!state.editing || state.busy) {
    return;
  }
  const editing = state.editing;
  const text = elements['block-editor-text'].value;
  const values = { text, ...getTextFormat() };
  cancelBlockEditor();`,
`function currentBlockEditorPdfRect(editing) {
  const bounds = state.pageModel.bounds;
  const editor = elements['block-editor'];
  const width = clamp(
    editor.getBoundingClientRect().width / state.render.scale,
    24,
    Math.max(24, bounds[2] - editing.rect[0])
  );
  return [editing.rect[0], editing.rect[1], editing.rect[0] + width, editing.rect[3]];
}

async function applyBlockEditor() {
  if (!state.editing || state.busy) {
    return;
  }
  const editing = state.editing;
  const text = elements['block-editor-text'].value;
  const values = { text, ...getTextFormat() };
  const targetRect = currentBlockEditorPdfRect(editing);
  cancelBlockEditor();`,
  'resizable text editor target rect'
);

main = replaceOnce(
  main,
  '    engine.insertTextBlock(state.currentPage, editing.rect, values);',
  '    engine.insertTextBlock(state.currentPage, targetRect, values);',
  'new text resized width'
);
main = replaceOnce(
  main,
`      text,
      values
    );`,
`      text,
      values,
      targetRect
    );`,
  'range edit resized width'
);
main = replaceOnce(
  main,
  '    engine.editTextBlock(state.currentPage, editing.blockIndex, values);',
  '    engine.editTextBlock(state.currentPage, editing.blockIndex, values, targetRect);',
  'block edit resized width'
);

main = replaceOnce(
  main,
  "    setStatus('Tabla seleccionada: cambia filas/columnas, muévela o elimínala.');",
  "    setStatus('Tabla seleccionada: arrastra para mover y usa esquinas o lados para redimensionar exactamente.');",
  'table resize status'
);

fs.writeFileSync(mainPath, main);

// --- CSS: custom glyph selection + resizable text editor -------------------
const cssPath = 'media/webview/styles.css';
let css = fs.readFileSync(cssPath, 'utf8');
css = replaceOnce(
  css,
`#pdf-canvas,
.text-layer,
.insertion-layer,
.page-stage > .canvas-container {`,
`#pdf-canvas,
.selection-layer,
.text-layer,
.insertion-layer,
.page-stage > .canvas-container {`,
  'selection layer absolute positioning'
);
css = replaceOnce(
  css,
`#pdf-canvas {
  z-index: 1;
}

.text-layer {`,
`#pdf-canvas {
  z-index: 1;
}

.selection-layer {
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
}

.selection-highlight {
  position: absolute;
  border-radius: 1px;
  background: color-mix(in srgb, var(--focus) 42%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--focus) 48%, transparent);
}

.text-layer {`,
  'selection layer styling'
);
css = replaceOnce(
  css,
`  overflow: hidden;
  color: transparent;
  border-radius: 2px;
  line-height: 1;`,
`  overflow: visible;
  color: transparent;
  border-radius: 0;
  line-height: 1;`,
  'text layer tight overflow'
);
css = replaceOnce(
  css,
`.text-layer-line:hover {
  background: color-mix(in srgb, var(--focus) 9%, transparent);
}

.text-layer-line.selected {
  background: color-mix(in srgb, var(--focus) 12%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--focus) 75%, transparent);
}

.text-layer-line::selection {
  color: transparent;
  background: color-mix(in srgb, var(--focus) 38%, transparent);
}`,
`.text-layer-line:hover {
  background: transparent;
}

.text-layer-line.selected {
  background: transparent;
  box-shadow: none;
}

.text-layer-line::selection {
  color: transparent;
  background: transparent;
}`,
  'remove inaccurate browser selection painting'
);
css = replaceOnce(
  css,
`.block-editor {
  position: absolute;
  z-index: 8;
  min-width: 180px;
  padding: 5px;`,
`.block-editor {
  position: absolute;
  z-index: 8;
  min-width: 80px;
  max-width: calc(100% - 2px);
  padding: 4px;
  box-sizing: border-box;
  resize: horizontal;
  overflow: auto;`,
  'resizable text editor frame'
);
css = replaceOnce(
  css,
`  width: 100%;
  min-height: 64px;
  resize: vertical;
  padding: 7px;`,
`  width: 100%;
  min-height: 28px;
  resize: none;
  padding: 3px 4px;`,
  'tight text editor textarea'
);
css = replaceOnce(
  css,
`  justify-content: flex-end;
  gap: 6px;`,
`  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;`,
  'editor actions wrapping'
);
fs.writeFileSync(cssPath, css);

// --- Contract tests ---------------------------------------------------------
const testPath = 'test/ui-contract.test.mjs';
fs.writeFileSync(testPath, `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport test from 'node:test';\nimport { URL } from 'node:url';\n\nconst read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');\nconst main = read('../media/webview/main.js');\nconst engine = read('../media/webview/pdf-engine.js');\nconst css = read('../media/webview/styles.css');\nconst html = read('../src/webview-html.js');\nconst provider = read('../src/pdf-editor-provider.js');\nconst pkg = JSON.parse(read('../package.json'));\n\ntest('v0.0.6 keeps 100 percent zoom and Marketplace icon metadata', () => {\n  assert.equal(pkg.version, '0.0.6');\n  assert.equal(pkg.icon, 'images/icon.png');\n  assert.equal(pkg.contributes.configuration.properties['pdfViewerEditor.defaultZoom'].default, 1);\n  assert.match(provider, /configuration\\.get\\('defaultZoom', 1\\)/);\n  assert.equal(fs.existsSync(new URL('../images/icon.png', import.meta.url)), true);\n});\n\ntest('text selection is painted from PDF character quads instead of browser line boxes', () => {\n  assert.match(engine, /characters: \[\]/);\n  assert.match(engine, /characterRect = normalizeRect\\(quadToRect\\(quad\\)\\)/);\n  assert.match(html, /id=\\"selection-layer\\"/);\n  assert.match(main, /renderTextSelection\\(block, start\\.offset, end\\.offset\\)/);\n  assert.match(css, /\\.text-layer-line::selection[\\s\\S]*background: transparent/);\n});\n\ntest('text blocks can change width and reflow using the resized editor frame', () => {\n  assert.match(css, /resize: horizontal/);\n  assert.match(main, /currentBlockEditorPdfRect/);\n  assert.match(main, /editTextBlock\\(state\\.currentPage, editing\\.blockIndex, values, targetRect\\)/);\n  assert.match(engine, /editTextBlock\\(pageIndex, blockIndex, properties = \{\}, targetRect = null\\)/);\n  assert.match(engine, /textLayoutRect\\(block\\.rect, targetRect\\)/);\n});\n\ntest('editable table geometry uses exact ink strokes and remains resizable', () => {\n  assert.match(engine, /rectFromInkStrokes/);\n  assert.match(engine, /rect: normalizedRect/);\n  assert.match(main, /lockScalingFlip: true/);\n  assert.match(main, /resizable: true/);\n});\n\ntest('save still writes current custom-document bytes', () => {\n  assert.match(provider, /workspace\\.fs\\.writeFile\\(document\\.uri, document\\.data\\)/);\n  assert.match(main, /PDF guardado correctamente/);\n});\n`);

// --- Documentation ----------------------------------------------------------
const changelogPath = 'CHANGELOG.md';
let changelog = fs.readFileSync(changelogPath, 'utf8');
if (!changelog.includes('## 0.0.6 - 2026-08-24')) {
  const marker = 'Todos los cambios relevantes de este proyecto se documentan aquí.\n';
  const section = `\n## 0.0.6 - 2026-08-24\n\n### Corregido\n\n- Selección visual calculada desde los quads reales de cada carácter del PDF; desaparecen los rectángulos desplazados o sobredimensionados.\n- Los límites de cada línea se calculan con geometría de glifos, no con el bbox amplio de MuPDF.\n- El editor de texto se puede redimensionar horizontalmente; al aplicar, el párrafo usa el nuevo ancho y hace reflow real.\n- Las tablas usan el rectángulo exacto de sus trazos Ink y conservan controles de movimiento/redimensionado.\n- Se mantiene zoom inicial 100%, Guardar funcional e icono 256×256 incluido para Marketplace.\n\n`;
  changelog = replaceOnce(changelog, marker, marker + section, 'CHANGELOG marker');
  fs.writeFileSync(changelogPath, changelog);
}

const readmePath = 'README.md';
let readme = fs.readFileSync(readmePath, 'utf8');
readme = readme.replace('La versión `0.0.5`', 'La versión `0.0.6`');
if (!readme.includes('quads reales de cada carácter')) {
  readme += `\n### Precisión de edición en 0.0.6\n\n- La selección se dibuja sobre los quads reales de cada carácter, no sobre cajas HTML aproximadas.\n- El editor de texto permite cambiar el ancho del bloque; el texto se recompone y desplaza el contenido inferior cuando corresponde.\n- Las tablas se pueden mover y redimensionar con un marco alineado con sus trazos reales.\n`;
}
fs.writeFileSync(readmePath, readme);

console.log('v0.0.6 geometry and resize fixes applied.');
