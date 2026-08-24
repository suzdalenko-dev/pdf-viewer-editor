    originX: 'left',
    originY: 'top',
    strokeUniform: true,
    centeredScaling: false,
    padding: 0,
    fill: options.fill || 'rgba(0, 0, 0, 0.001)',""",
    'Fabric object origin and stroke geometry'
)

object_rect_start = "function objectScreenRectToPdf(object) {"
object_rect_end = "\nfunction setTextControlsFromBlock(block) {"
object_rect_replacement = """function objectScreenRectToPdf(object) {
  // All editable Fabric objects are axis-aligned with a left/top origin.
  // Using the object's content box (not getBoundingRect, which includes the
  // visual stroke) keeps the blue frame and the PDF target rectangle identical.
  const left = Number(object.left || 0);
  const top = Number(object.top || 0);
  const width = Math.max(2, Number(object.width || 0) * Math.abs(Number(object.scaleX || 1)));
  const height = Math.max(2, Number(object.height || 0) * Math.abs(Number(object.scaleY || 1)));
  return screenRectToPdf([left, top, left + width, top + height]);
}
"""
main = replace_between(main, object_rect_start, object_rect_end, object_rect_replacement, 'Fabric object rectangle conversion')

main = replace_once(
    main,
    """  openBlockEditor({
    mode: 'range',
    blockIndex: block.index,
    start: selectedRange.start,
    end: selectedRange.end,
    rect: block.rect,
    text: selectedRange.text
  });""",
    """  openBlockEditor({
    mode: 'range',
    blockIndex: block.index,
    start: selectedRange.start,
    end: selectedRange.end,
    sourceRect: block.rect,
    rect: getTextRangeRect(selectedRange) || block.rect,
    text: selectedRange.text
  });""",
    'range editor exact rectangle'
)

main = replace_once(
    main,
    """  openBlockEditor({
    mode: 'add',
    blockIndex: null,
    rect: [x, y, x + width, y + 18],
    text: ''
  });""",
    """  openBlockEditor({
    mode: 'add',
    blockIndex: null,
    rect: [x, y, x + width, Math.min(bounds[3] - 8, y + 72)],
    text: ''
  });""",
    'new text initial box height'
)

open_editor_start = "function openBlockEditor(editing) {"
open_editor_end = "\nfunction syncBlockEditorPreview() {"
open_editor_replacement = """function openBlockEditor(editing) {
  state.editing = { ...editing };
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
  autoGrowBlockEditor();
  syncEditingRectFromEditor();
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
"""
main = replace_between(main, open_editor_start, open_editor_end, open_editor_replacement, 'block editor exact geometry')

autogrow_start = "function autoGrowBlockEditor() {"
autogrow_end = "\nfunction cancelBlockEditor() {"
autogrow_replacement = """function autoGrowBlockEditor() {
  if (!state.editing) {
    return;
  }
  const textarea = elements['block-editor-text'];
  const editorRect = textarea.getBoundingClientRect();
  const stageRect = elements['page-stage'].getBoundingClientRect();
  const maximumHeight = Math.max(18, state.render.height - (editorRect.top - stageRect.top));
  const requiredHeight = clamp(textarea.scrollHeight + 4, 18, maximumHeight);
  if (requiredHeight > editorRect.height + 1) {
    textarea.style.height = `${requiredHeight}px`;
  }
  syncEditingRectFromEditor();
}
"""
main = replace_between(main, autogrow_start, autogrow_end, autogrow_replacement, 'block editor auto grow')

main = replace_once(
    main,
    """  } else {
    engine.editTextBlock(state.currentPage, editing.blockIndex, values);
    await commitAndRefresh(text ? 'Editar texto' : 'Eliminar texto', {
      restoreText: text || null
    });
  }""",
    """  } else {
    engine.editTextBlock(state.currentPage, editing.blockIndex, {
      ...values,
      targetRect: editing.rect
    });
    await commitAndRefresh(text ? 'Editar texto' : 'Eliminar texto', {
      restoreText: text || null
    });
  }""",
    'apply edited block target rectangle'
)

main_path.write_text(main, encoding='utf-8')


# ---------------------------------------------------------------------------
# media/webview/pdf-engine.js
# ---------------------------------------------------------------------------
engine_path = ROOT / 'media/webview/pdf-engine.js'
engine = engine_path.read_text(encoding='utf-8')

read_annotations_start = "  readAnnotations(page) {"
read_annotations_end = "\n  readWidgets(page) {"
read_annotations_replacement = """  readAnnotations(page) {
    const annotations = page.getAnnotations();
    return annotations.map((annotation, index) => {
      try {
        const type = annotation.getType();
        const contents = safeCall(() => annotation.getContents(), '');
        const subject = safeCall(() => annotation.getSubject(), '');
        const table = parseTableMetadata(type, subject, contents);
        let rect = table?.rect ? [...table.rect] : null;
        if (!rect && table) {
          rect = safeCall(() => [...annotation.getBounds()], null);
        }
        if (!rect) {
          rect = annotation.hasRect()
            ? [...annotation.getRect()]
            : [...annotation.getBounds()];
        }

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
          rect,
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
