import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const main = read('../media/webview/main.js');
const engine = read('../media/webview/pdf-engine.js');
const provider = read('../src/pdf-editor-provider.js');
const html = read('../src/webview-html.js');
const vendorScript = read('../scripts/copy-vendor.js');
const pkg = JSON.parse(read('../package.json'));

test('v0.0.8 metadata describes the read-only viewer', () => {
  assert.equal(pkg.version, '0.0.8');
  assert.equal(pkg.displayName, 'PDF Viewer (Read Only)');
  assert.match(pkg.description, /read-only PDF viewer/i);
  assert.equal(pkg.icon, 'images/icon.png');
  assert.equal(fs.existsSync(new URL('../images/icon.png', import.meta.url)), true);
  assert.equal(
    pkg.contributes.configuration.properties['pdfViewerEditor.defaultSaveMode'],
    undefined
  );
});

test('default zoom remains 100 percent throughout the shipped viewer', () => {
  assert.equal(pkg.contributes.configuration.properties['pdfViewerEditor.defaultZoom'].default, 1);
  assert.match(main, /zoom: 1,/);
  assert.match(provider, /configuration\.get\('defaultZoom', 1\)/);
});

test('extension host is a read-only custom editor provider with no write path', () => {
  assert.match(provider, /class PdfViewerProvider/);
  assert.doesNotMatch(provider, /workspace\.fs\.writeFile/);
  assert.doesNotMatch(provider, /onDidChangeCustomDocument/);
  assert.doesNotMatch(provider, /async saveCustomDocument/);
  assert.doesNotMatch(provider, /async saveCustomDocumentAs/);
  assert.doesNotMatch(provider, /async backupCustomDocument/);
  assert.doesNotMatch(provider, /case 'document-edited'/);
  assert.doesNotMatch(provider, /case 'export'/);
});

test('webview contains viewing controls and no editing controls', () => {
  assert.match(html, /Solo lectura/);
  assert.match(html, /v0\.0\.8/);
  assert.match(html, /id="search-input"/);
  assert.match(html, /id="zoom-select"/);
  assert.match(html, /id="thumbnail-list"/);
  assert.doesNotMatch(html, /id="save-button"/);
  assert.doesNotMatch(html, /id="undo-button"/);
  assert.doesNotMatch(html, /id="editor-canvas"/);
  assert.doesNotMatch(html, /fabric\.min\.js/);
});

test('webview and engine do not send or expose document mutations', () => {
  assert.doesNotMatch(main, /document-edited/);
  assert.doesNotMatch(main, /postCommand/);
  assert.doesNotMatch(main, /\.serialize\(/);
  assert.doesNotMatch(main, /\bfabric\b/i);
  assert.doesNotMatch(engine, /enableJournal\(/);
  assert.doesNotMatch(engine, /saveToBuffer\(/);
  assert.doesNotMatch(engine, /beginOperation\(/);
  assert.doesNotMatch(engine, /createAnnotation\(/);
});

test('Fabric is removed from dependencies and generated vendor assets', () => {
  assert.equal(pkg.devDependencies.fabric, undefined);
  assert.doesNotMatch(vendorScript, /fabric/i);
});
