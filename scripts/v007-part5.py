
# ---------------------------------------------------------------------------
# MuPDF Ink annotations derive their geometry from the ink list and do not
# support an explicit Rect entry. Keep our canonical table rectangle in the
# JSON metadata instead; readAnnotations() already prioritizes table.rect.
# ---------------------------------------------------------------------------
engine_path = ROOT / 'media/webview/pdf-engine.js'
engine = engine_path.read_text(encoding='utf-8')
engine = replace_once(
    engine,
    "      annotation.setRect(normalizedRect);\n      annotation.setInkList(strokes);",
    "      annotation.setInkList(strokes);",
    'remove unsupported Ink setRect'
)
engine_path.write_text(engine, encoding='utf-8')

ui_test_path = ROOT / 'test/ui-contract.test.mjs'
ui_test = ui_test_path.read_text(encoding='utf-8')
ui_test = ui_test.replace(
    "  assert.match(engine, /annotation\\.setRect\\(normalizedRect\\)/);\n",
    "  assert.doesNotMatch(engine, /annotation\\.setRect\\(normalizedRect\\)/);\n",
    1
)
ui_test_path.write_text(ui_test, encoding='utf-8')

print('v0.0.7 Ink table geometry compatibility applied')
