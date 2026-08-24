from pathlib import Path
import json
import re

ROOT = Path('.')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f'{label}: start marker not found')
    end_index = text.find(end, start_index + len(start))
    if end_index < 0:
        raise RuntimeError(f'{label}: end marker not found')
    if text.find(start, start_index + 1) >= 0:
        raise RuntimeError(f'{label}: start marker is not unique')
    return text[:start_index] + replacement + text[end_index:]


# ---------------------------------------------------------------------------
# package.json / package-lock.json
# ---------------------------------------------------------------------------
package_path = ROOT / 'package.json'
package_data = json.loads(package_path.read_text(encoding='utf-8'))
package_data['version'] = '0.0.7'
package_data['icon'] = 'images/icon.png'
package_path.write_text(json.dumps(package_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

lock_path = ROOT / 'package-lock.json'
lock_text = lock_path.read_text(encoding='utf-8')
lock_text = replace_once(lock_text, '"version": "0.0.6"', '"version": "0.0.7"', 'package-lock root version')
lock_text = replace_once(lock_text, '"version": "0.0.6"', '"version": "0.0.7"', 'package-lock package version')
lock_path.write_text(lock_text, encoding='utf-8')


# ---------------------------------------------------------------------------
# media/webview/main.js
# ---------------------------------------------------------------------------
main_path = ROOT / 'media/webview/main.js'
main = main_path.read_text(encoding='utf-8')

main = replace_once(
    main,
    "].map((id) => [id, document.getElementById(id)]));\n\nwindow.addEventListener('message', async (event) => {",
    """].map((id) => [id, document.getElementById(id)]));

const blockEditorResizeObserver = new window.ResizeObserver(() => {
  if (state.editing && !elements['block-editor'].classList.contains('hidden')) {
    syncEditingRectFromEditor();
  }
});
blockEditorResizeObserver.observe(elements['block-editor-text']);

window.addEventListener('message', async (event) => {""",
    'block editor ResizeObserver'
)

main = replace_once(
    main,
    """  }
  state.fabricCanvas.clear();
  state.overlayObjects = [];
}

function buildTextLayer() {""",
    """  }
  syncFabricCanvasGeometry();
  state.fabricCanvas.clear();
  state.overlayObjects = [];
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

function buildTextLayer() {""",
    'Fabric canvas geometry sync'
)

render_start = "function renderTextRangeHighlights() {"
render_end = "\nfunction setTextResizeMode(active) {"
render_replacement = """function getTextRangeRects(selectedRange) {
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
    const selectedCharacters = characters.slice(localStart, localEnd)
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
"""
main = replace_between(main, render_start, render_end, render_replacement, 'precise range geometry helpers')

main = replace_once(
    main,
    """    left: screen[0],
    top: screen[1],
    width: Math.max(2, screen[2] - screen[0]),
    height: Math.max(2, screen[3] - screen[1]),
    fill: options.fill || 'rgba(0, 0, 0, 0.001)',""",
    """    left: screen[0],
    top: screen[1],
    width: Math.max(2, screen[2] - screen[0]),
    height: Math.max(2, screen[3] - screen[1]),
