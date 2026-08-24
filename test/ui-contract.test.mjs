import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const main = fs.readFileSync(new URL('../media/webview/main.js', import.meta.url), 'utf8');
const provider = fs.readFileSync(new URL('../src/pdf-editor-provider.js', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const styles = fs.readFileSync(new URL('../media/webview/styles.css', import.meta.url), 'utf8');
const engine = fs.readFileSync(new URL('../media/webview/pdf-engine.js', import.meta.url), 'utf8');

test('default zoom is 100 percent throughout the shipped extension', () => {
  assert.equal(pkg.contributes.configuration.properties['pdfViewerEditor.defaultZoom'].default, 1);
  assert.match(main, /zoom: 1,/);
  assert.match(provider, /configuration\.get\('defaultZoom', 1\)/);
});

test('text selection hit-tests extracted PDF characters instead of browser text layout', () => {
  assert.match(main, /textOffsetAtScreenPoint/);
  assert.match(main, /closest\.character\.start/);
  assert.match(main, /closest\.character\.end/);
  assert.match(main, /character\.end > selectedRange\.start/);
  assert.doesNotMatch(main, /range\.selectNodeContents/);
  assert.doesNotMatch(main, /selectionchange/);
});

test('save writes the custom document and sends visible acknowledgement', () => {
  assert.match(provider, /workspace\.fs\.writeFile\(document\.uri, document\.data\)/);
  assert.match(provider, /type: 'document-saved'/);
  assert.match(main, /PDF guardado correctamente/);
});

test('marketplace icon metadata is present', () => {
  assert.equal(pkg.icon, 'images/icon.png');
  assert.equal(fs.existsSync(new URL('../images/icon.png', import.meta.url)), true);
  assert.equal(pkg.version, '0.0.7');
});


test('v0.0.7 keeps overlays in one coordinate system and supports text resizing', () => {
  assert.match(main, /enableRetinaScaling: false/);
  assert.match(engine, /pageToScreen/);
  assert.match(main, /invertMatrix\(state\.render\.pageToScreen\)/);
  assert.match(main, /object\.width \|\| 0/);
  assert.match(main, /resize-text-block/);
  assert.match(main, /engine\.resizeTextBlock/);
});

test('v0.0.7 renders text selection from extracted PDF character rectangles', () => {
  assert.match(engine, /characters: currentLine\.characters/);
  assert.match(main, /text-range-highlight/);
  assert.match(main, /selectedCharacters/);
});


test('v0.0.7 uses the blue editor box as the real text target rectangle', () => {
  assert.match(main, /new window\.ResizeObserver/);
  assert.match(main, /syncEditingRectFromEditor/);
  assert.match(main, /targetRect: editing\.rect/);
  assert.match(styles, /resize: both/);
  assert.match(styles, /border: 2px solid var\(--focus\)/);
});

test('v0.0.7 stores exact table geometry and uses it for the overlay', () => {
  assert.doesNotMatch(engine, /annotation\.setRect\(normalizedRect\)/);
  assert.match(engine, /rect: normalizedRect/);
  assert.match(engine, /table\.rect/);
  assert.match(engine, /rectFromInkStrokes/);
});

test('range editing preserves the exact selected box and turns manual width changes into reflow', () => {
  assert.match(main, /initialRect: \[\.\.\.editing\.rect\]/);
  assert.match(main, /editedWidth - initialWidth/);
  assert.match(main, /targetRect:/);
  assert.doesNotMatch(main, /textarea\.scrollHeight/);
});
