'use strict';

const vscode = require('vscode');
const { PdfViewerProvider, VIEW_TYPE } = require('./pdf-editor-provider');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new PdfViewerProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('pdfViewerEditor.openWith', async (resource) => {
      const uri = resource instanceof vscode.Uri
        ? resource
        : await selectPdfFile();
      if (uri) {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      }
    }),
    provider
  );
}

/** @returns {Promise<vscode.Uri | undefined>} */
async function selectPdfFile() {
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Open PDF',
    filters: {
      PDF: ['pdf']
    }
  });
  return selection?.[0];
}

function deactivate() {
  // All resources are disposed through ExtensionContext subscriptions.
}

module.exports = {
  activate,
  deactivate
};
