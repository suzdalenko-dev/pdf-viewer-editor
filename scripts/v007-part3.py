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
"""
engine = replace_between(engine, read_annotations_start, read_annotations_end, read_annotations_replacement, 'annotation geometry')

edit_block_start = "  editTextBlock(pageIndex, blockIndex, properties = {}) {"
edit_block_end = "\n  /**\n   * Replaces an arbitrary character range inside an extracted text block."
edit_block_replacement = """  editTextBlock(pageIndex, blockIndex, properties = {}) {
    const model = this.getPageModel(pageIndex);
    const block = model.textBlocks.find((candidate) => candidate.index === blockIndex);
    if (!block) {
      throw new Error('The selected text block no longer exists. Select it again.');
    }

    const values = normalizeBlockProperties(block, properties);
    const requested = values.text && Array.isArray(properties.targetRect)
      ? normalizeRect(properties.targetRect)
      : [...block.rect];
    const minimumWidth = Math.max(24, Number(values.fontSize || block.font?.size || 12) * 2);
    const targetRect = [
      requested[0],
      requested[1],
      Math.max(requested[0] + minimumWidth, requested[2]),
      requested[3]
    ];
    const layoutRect = [targetRect[0], targetRect[1], targetRect[2], targetRect[1]];
    const layout = layoutTextBlock(layoutRect, values, block.metrics, block);
    const newBottom = values.text ? targetRect[1] + layout.height : block.rect[1];
    const delta = newBottom - block.rect[3];
    const followingBlocks = findFollowingBlocks(model.textBlocks, block.rect, block.index);
    const shiftedEntries = followingBlocks.flatMap((followingBlock) =>
      textEntriesForExistingBlock(followingBlock, delta)
    );

    this.withOperation(values.text ? 'Edit text block' : 'Delete text block', () => {
      this.withPage(pageIndex, (page) => {
        for (const sourceBlock of [block, ...followingBlocks]) {
          this.removeContentInRect(page, expandRect(sourceBlock.rect, 0.35), {
            images: false,
            lineArt: false,
            text: true
          });
        }

        const entries = values.text
          ? [...layout.entries, ...shiftedEntries]
          : shiftedEntries;
        const maximumBottom = Math.max(
          values.text ? newBottom : block.rect[1],
          ...followingBlocks.map((candidate) => candidate.rect[3] + delta)
        );
        this.extendPageToFit(page, maximumBottom);
        this.appendStaticText(page, entries);
      });
    });

    return {
      delta,
      shiftedBlocks: followingBlocks.length,
      rect: values.text
        ? [targetRect[0], targetRect[1], targetRect[2], newBottom]
        : [block.rect[0], block.rect[1], block.rect[2], block.rect[1]]
    };
  }
"""
engine = replace_between(engine, edit_block_start, edit_block_end, edit_block_replacement, 'edit text inside target box')

engine = replace_once(
    engine,
    """    const annotation = page.createAnnotation('Ink');
    try {
      annotation.setInkList(strokes);""",
    """    const annotation = page.createAnnotation('Ink');
    try {
      annotation.setRect(normalizedRect);
      annotation.setInkList(strokes);""",
    'table annotation rectangle'
)

engine = replace_once(
    engine,
    """        type: 'table',
        rows: rowCount,
        columns: columnCount,
        color,
        borderWidth
      }));""",
    """        type: 'table',
        rows: rowCount,
        columns: columnCount,
        color,
        borderWidth,
        rect: normalizedRect
      }));""",
    'table metadata rectangle'
)

engine = replace_once(
    engine,
    """    return {
      rows: Math.max(1, Math.min(30, Math.round(Number(value.rows) || 2))),
      columns: Math.max(1, Math.min(20, Math.round(Number(value.columns) || 2))),
      color: normalizeColor(value.color, [0, 0, 0]),
      borderWidth: Math.max(0.25, Math.min(8, Number(value.borderWidth || 1)))
    };""",
    """    return {
      rows: Math.max(1, Math.min(30, Math.round(Number(value.rows) || 2))),
      columns: Math.max(1, Math.min(20, Math.round(Number(value.columns) || 2))),
      color: normalizeColor(value.color, [0, 0, 0]),
      borderWidth: Math.max(0.25, Math.min(8, Number(value.borderWidth || 1))),
      rect: Array.isArray(value.rect) && value.rect.length === 4
        ? normalizeRect(value.rect.map(Number))
        : null
    };""",
    'parse table rectangle metadata'
)

engine_path.write_text(engine, encoding='utf-8')


# ---------------------------------------------------------------------------
# media/webview/styles.css
# ---------------------------------------------------------------------------
styles_path = ROOT / 'media/webview/styles.css'
styles = styles_path.read_text(encoding='utf-8')

styles = replace_once(
    styles,
    """#pdf-canvas,
.text-layer,
.insertion-layer,
.page-stage > .canvas-container {
  position: absolute !important;
  inset: 0;
}
""",
    """#pdf-canvas,
.text-layer,
.insertion-layer,
.page-stage > .canvas-container {
  position: absolute !important;
  inset: 0;
}

.page-stage > .canvas-container,
.page-stage > .canvas-container .lower-canvas,
.page-stage > .canvas-container .upper-canvas {
  left: 0 !important;
  top: 0 !important;
  margin: 0 !important;
}
""",
    'canvas absolute origin CSS'
)

block_css_start = ".block-editor {"
block_css_end = "\n.statusbar {"
block_css_replacement = """.block-editor {
  position: absolute;
  z-index: 8;
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: visible;
  background: transparent;
}

.block-editor textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 24px;
  min-height: 18px;
  resize: both;
  padding: 2px 3px;
  overflow: auto;
  border: 2px solid var(--focus);
  border-radius: 2px;
  outline: 0;
  color: #111;
  background: rgba(255, 255, 255, 0.98);
  line-height: 1.18;
  white-space: pre-wrap;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.22);
}

.block-editor textarea:focus {
  outline: 0;
  border-color: var(--focus);
}

.block-editor-actions {
  display: flex;
