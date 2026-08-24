  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  width: max-content;
  min-width: 100%;
  padding-top: 5px;
}

.block-editor-actions span {
  margin-right: auto;
  color: var(--muted);
  font-size: 11px;
}
"""
styles = replace_between(styles, block_css_start, block_css_end, block_css_replacement, 'resizable blue text editor')

styles += """

.version-badge {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
"""
styles_path.write_text(styles, encoding='utf-8')


# ---------------------------------------------------------------------------
# src/webview-html.js
# ---------------------------------------------------------------------------
html_path = ROOT / 'src/webview-html.js'
html = html_path.read_text(encoding='utf-8')
html = replace_once(
    html,
    """      <span id=\"tool-hint\" class=\"tool-hint\">Haz clic en un párrafo, selecciona texto o usa + para insertar.</span>
    </nav>""",
    """      <span id=\"tool-hint\" class=\"tool-hint\">Haz clic en un párrafo, selecciona texto o usa + para insertar.</span>
      <span class=\"version-badge\" title=\"Versión instalada\">v0.0.7</span>
    </nav>""",
    'visible installed version badge'
)
html = replace_once(
    html,
    '<button id="resize-text-block">Mover / redimensionar</button>',
    '<button id="resize-text-block">Mover / redimensionar bloque</button>',
    'clear resize button label'
)
html_path.write_text(html, encoding='utf-8')


# ---------------------------------------------------------------------------
# test/ui-contract.test.mjs
# ---------------------------------------------------------------------------
ui_test_path = ROOT / 'test/ui-contract.test.mjs'
ui_test = ui_test_path.read_text(encoding='utf-8')
ui_test = replace_once(
    ui_test,
    "const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));",
    """const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const styles = fs.readFileSync(new URL('../media/webview/styles.css', import.meta.url), 'utf8');
const engine = fs.readFileSync(new URL('../media/webview/pdf-engine.js', import.meta.url), 'utf8');""",
    'UI contract load CSS and engine'
)
ui_test = ui_test.replace("assert.equal(pkg.version, '0.0.6');", "assert.equal(pkg.version, '0.0.7');")
ui_test = ui_test.replace("test('v0.0.6 keeps overlays in one coordinate system and supports text resizing'", "test('v0.0.7 keeps overlays in one coordinate system and supports text resizing'")
ui_test = ui_test.replace("test('v0.0.6 renders text selection from extracted PDF character rectangles'", "test('v0.0.7 renders text selection from extracted PDF character rectangles'")
ui_test = ui_test.replace("  const engine = fs.readFileSync(new URL('../media/webview/pdf-engine.js', import.meta.url), 'utf8');\n", "")
ui_test = ui_test.replace("  assert.match(main, /object\\.getBoundingRect\\(\\)/);", "  assert.match(main, /object\\.width \\|\\| 0/);")
ui_test += """

test('v0.0.7 uses the blue editor box as the real text target rectangle', () => {
  assert.match(main, /new window\.ResizeObserver/);
  assert.match(main, /syncEditingRectFromEditor/);
  assert.match(main, /targetRect: editing\.rect/);
  assert.match(styles, /resize: both/);
  assert.match(styles, /border: 2px solid var\(--focus\)/);
});

test('v0.0.7 stores exact table geometry and uses it for the overlay', () => {
  assert.match(engine, /annotation\.setRect\(normalizedRect\)/);
  assert.match(engine, /rect: normalizedRect/);
  assert.match(engine, /table\?\.rect/);
});
"""
ui_test_path.write_text(ui_test, encoding='utf-8')


# ---------------------------------------------------------------------------
# test/pdf-engine.test.mjs
# ---------------------------------------------------------------------------
engine_test_path = ROOT / 'test/pdf-engine.test.mjs'
engine_test = engine_test_path.read_text(encoding='utf-8')
engine_test += r'''

test('v0.0.7 text edits honor a new bounding box width and position', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createFlowingTextPdf());
    const original = engine.getPageModel(0).textBlocks.find((block) =>
      block.text.includes('First paragraph')
    );
    assert.ok(original);
    const targetRect = [62, original.rect[1] + 4, 176, original.rect[3] + 4];
    const result = engine.editTextBlock(0, original.index, {
      text: 'First paragraph edited inside a deliberately narrower resizable box with enough words to wrap.',
      fontFamily: 'Helvetica',
      fontSize: 12,
      targetRect
    });
    assert.ok(Math.abs(result.rect[0] - targetRect[0]) < 0.01);
    assert.ok(Math.abs(result.rect[2] - targetRect[2]) < 0.01);
    const edited = engine.getPageModel(0).textBlocks.find((block) =>
      block.text.includes('deliberately narrower')
    );
    assert.ok(edited);
    assert.ok(edited.rect[0] >= targetRect[0] - 3);
    assert.ok(edited.rect[2] <= targetRect[2] + 3);
  } finally {
    engine.destroy();
  }
});

test('v0.0.7 table metadata keeps the blue selection rectangle equal to the table', () => {
  const engine = new PdfEngine();
  try {
    engine.load(createOnePagePdf());
    const initialRect = [42, 90, 242, 190];
    engine.addTable(0, initialRect, 3, 4, { borderWidth: 1.5 });
    let table = engine.getPageModel(0).annotations.find((annotation) => annotation.table);
    assert.ok(table);
    assert.deepEqual(table.rect.map((value) => Math.round(value)), initialRect);

    const resizedRect = [55, 105, 270, 235];
    engine.updateTable(0, table.index, resizedRect, 4, 5, { borderWidth: 2 });
    table = engine.getPageModel(0).annotations.find((annotation) => annotation.table);
    assert.ok(table);
    assert.deepEqual(table.rect.map((value) => Math.round(value)), resizedRect);
    assert.equal(table.table.rows, 4);
    assert.equal(table.table.columns, 5);
  } finally {
    engine.destroy();
  }
});
'''
engine_test_path.write_text(engine_test, encoding='utf-8')


# ---------------------------------------------------------------------------
# CHANGELOG / README
# ---------------------------------------------------------------------------
changelog_path = ROOT / 'CHANGELOG.md'
changelog = changelog_path.read_text(encoding='utf-8')
section = """## 0.0.7 - 2026-08-24

### Corregido

- El marco azul de edición de texto pasa a ser el área real del contenido editable.
- El editor de texto se puede redimensionar en anchura y altura; el reflow usa esa anchura al aplicar.
- La selección parcial usa el rectángulo exacto de los caracteres seleccionados.
- Las tablas guardan y recuperan su rectángulo exacto, evitando que el marco Fabric quede desplazado respecto a la cuadrícula.
- Las capas PDF, texto y Fabric se fuerzan al mismo origen de coordenadas.
- Se mantiene el icono `images/icon.png` dentro del VSIX y se añade un indicador visible `v0.0.7` para comprobar la versión instalada.

"""
changelog = replace_once(
    changelog,
    'Todos los cambios relevantes de este proyecto se documentan aquí.\n\n',
    'Todos los cambios relevantes de este proyecto se documentan aquí.\n\n' + section,
    'v0.0.7 changelog section'
)
changelog_path.write_text(changelog, encoding='utf-8')

readme_path = ROOT / 'README.md'
readme = readme_path.read_text(encoding='utf-8')
readme = readme.replace('La versión `0.0.5`', 'La versión `0.0.7`', 1)
readme = readme.replace(
    '- Editar un párrafo completo con `Editar contenido`.',
    '- Editar un párrafo completo con `Editar contenido`; el marco azul coincide con el área real y se puede redimensionar.',
    1
)
readme = readme.replace(
    '- Seleccionar una tabla creada, moverla y redimensionarla.',
    '- Seleccionar una tabla creada, moverla y redimensionarla con un marco que coincide exactamente con la cuadrícula.',
    1
)
readme = readme.replace('pdf-viewer-editor-0.0.4.vsix', 'pdf-viewer-editor-0.0.7.vsix')
readme_path.write_text(readme, encoding='utf-8')


# Remove the accidental staging helper merged by PR #9. It is never shipped.
for stale in [
    ROOT / 'scripts/apply-v006-fixes.js',
    ROOT / 'scripts/apply-v006-fixes.py'
]:
    if stale.exists():
        stale.unlink()

print('v0.0.7 unified edit-box fixes applied')
