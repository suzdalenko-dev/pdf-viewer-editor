'use strict';

const fs = require('node:fs');

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  return source.replace(before, after);
}

const mainPath = 'media/webview/main.js';
let main = fs.readFileSync(mainPath, 'utf8');
main = main.replace("  zoom: 1.25,", "  zoom: 1,");
main = main.replace("    defaultZoom: 1.25,", "    defaultZoom: 1,");
main = main.replace("    state.zoom = Number(state.settings.defaultZoom || 1.25);", "    state.zoom = Number(state.settings.defaultZoom || 1);");

main = replaceOnce(
  main,
`function textLineClicked(event) {
  if (state.tool !== 'edit' || state.busy) {
    return;
  }
  hideInsertMenu();
  const blockIndex = Number(event.currentTarget.dataset.blockIndex);
  window.requestAnimationFrame(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selectionInsideTextLayer(selection)) {
      updateTextRangeFromSelection();
    } else {
      selectTextBlock(blockIndex);
    }
  });
}`,
`function textLineClicked(event) {
  if (state.tool !== 'edit' || state.busy) {
    return;
  }
  hideInsertMenu();
  const line = event.currentTarget;
  window.requestAnimationFrame(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selectionInsideTextLayer(selection)) {
      updateTextRangeFromSelection();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(line);
    selection?.removeAllRanges();
    selection?.addRange(range);
    updateTextRangeFromSelection();
  });
}`,
  'replace textLineClicked'
);

main = replaceOnce(
  main,
`  for (const line of elements['text-layer'].querySelectorAll('.text-layer-line')) {
    line.classList.toggle('selected', Number(line.dataset.blockIndex) === blockIndex);
  }
  selectMeta(meta);`,
`  clearTextLineHighlights();
  selectMeta(meta);`,
  'remove paragraph-wide highlight'
);

main = replaceOnce(
  main,
`  } else if (message.type === 'operation-error') {
    setBusy(false);
    setStatus(message.message, 'error');
  }`,
`  } else if (message.type === 'operation-error') {
    setBusy(false);
    setStatus(message.message, 'error');
  } else if (message.type === 'document-saved') {
    setBusy(false);
    setStatus('PDF guardado correctamente.');
  }`,
  'saved acknowledgement'
);

main = replaceOnce(
  main,
`  elements['save-button'].addEventListener('click', () => postCommand('save'));`,
`  elements['save-button'].addEventListener('click', () => {
    if (state.busy) {
      return;
    }
    setBusy(true, 'Guardando PDF…');
    postCommand('save');
  });`,
  'save button feedback'
);

fs.writeFileSync(mainPath, main);

const providerPath = 'src/pdf-editor-provider.js';
let provider = fs.readFileSync(providerPath, 'utf8');
provider = replaceOnce(
  provider,
`      case 'command':
        await this.executeEditorCommand(String(message.command || ''));
        return;`,
`      case 'command':
        await this.executeEditorCommand(document, panel, String(message.command || ''));
        return;`,
  'command dispatch'
);
provider = replaceOnce(
  provider,
`  /**
   * @param {string} command
   */
  async executeEditorCommand(command) {
    const allowedCommands = new Map([
      ['save', 'workbench.action.files.save'],
      ['saveAs', 'workbench.action.files.saveAs'],
      ['undo', 'undo'],
      ['redo', 'redo']
    ]);
    const vscodeCommand = allowedCommands.get(command);
    if (vscodeCommand) {
      await vscode.commands.executeCommand(vscodeCommand);
    }
  }`,
`  /**
   * @param {PdfDocument} document
   * @param {vscode.WebviewPanel} panel
   * @param {string} command
   */
  async executeEditorCommand(document, panel, command) {
    if (command === 'save') {
      await vscode.workspace.fs.writeFile(document.uri, document.data);
      await vscode.commands.executeCommand('workbench.action.files.save');
      await panel.webview.postMessage({ type: 'document-saved' });
      return;
    }

    const allowedCommands = new Map([
      ['saveAs', 'workbench.action.files.saveAs'],
      ['undo', 'undo'],
      ['redo', 'redo']
    ]);
    const vscodeCommand = allowedCommands.get(command);
    if (vscodeCommand) {
      await vscode.commands.executeCommand(vscodeCommand);
    }
  }`,
  'executeEditorCommand'
);
provider = provider.replace("defaultZoom: configuration.get('defaultZoom', 1.25),", "defaultZoom: configuration.get('defaultZoom', 1),");
fs.writeFileSync(providerPath, provider);

const packagePath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = '0.0.5';
pkg.icon = 'images/icon.png';
pkg.galleryBanner = { color: '#0f172a', theme: 'dark' };
pkg.contributes.configuration.properties['pdfViewerEditor.defaultZoom'].default = 1;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const lockPath = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (lock.packages?.['']) {
  lock.packages[''].version = '0.0.5';
}
if (lock.version) {
  lock.version = '0.0.5';
}
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

fs.writeFileSync('test/ui-contract.test.mjs', `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport test from 'node:test';\nimport { URL } from 'node:url';\n\nconst main = fs.readFileSync(new URL('../media/webview/main.js', import.meta.url), 'utf8');\nconst provider = fs.readFileSync(new URL('../src/pdf-editor-provider.js', import.meta.url), 'utf8');\nconst pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));\n\ntest('default zoom is 100 percent throughout the shipped extension', () => {\n  assert.equal(pkg.contributes.configuration.properties['pdfViewerEditor.defaultZoom'].default, 1);\n  assert.match(main, /zoom: 1,/);\n  assert.match(provider, /configuration\\.get\\('defaultZoom', 1\\)/);\n});\n\ntest('single-click text selection uses a native line range instead of paragraph-wide highlight', () => {\n  assert.match(main, /range\\.selectNodeContents\\(line\\)/);\n  assert.doesNotMatch(main, /line\\.classList\\.toggle\\('selected', Number\\(line\\.dataset\\.blockIndex\\) === blockIndex\\)/);\n});\n\ntest('save writes the custom document and sends visible acknowledgement', () => {\n  assert.match(provider, /workspace\\.fs\\.writeFile\\(document\\.uri, document\\.data\\)/);\n  assert.match(provider, /type: 'document-saved'/);\n  assert.match(main, /PDF guardado correctamente/);\n});\n\ntest('marketplace icon metadata is present', () => {\n  assert.equal(pkg.icon, 'images/icon.png');\n  assert.equal(fs.existsSync(new URL('../images/icon.png', import.meta.url)), true);\n  assert.equal(pkg.version, '0.0.5');\n});\n`);

console.log('v0.0.5 fixes applied.');
