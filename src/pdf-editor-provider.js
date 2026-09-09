'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { bytesToBase64 } = require('./base64');
const { PdfDocument } = require('./pdf-document');
const { getWebviewHtml } = require('./webview-html');

// Keep the existing view type so upgrades retain their PDF editor association.
const VIEW_TYPE = 'pdfViewerEditor.editor';

class PdfViewerProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
  }

  /**
   * This class intentionally implements CustomReadonlyEditorProvider only. It
   * has no change, save, save-as, backup, revert, undo, or redo hooks.
   *
   * @param {vscode.Uri} uri
   * @param {vscode.CustomDocumentOpenContext} _openContext
   * @param {vscode.CancellationToken} _token
   * @returns {Promise<PdfDocument>}
   */
  async openCustomDocument(uri, _openContext, _token) {
    const data = await vscode.workspace.fs.readFile(uri);
    return new PdfDocument(uri, data);
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.WebviewPanel} webviewPanel
   * @param {vscode.CancellationToken} _token
   */
  async resolveCustomEditor(document, webviewPanel, _token) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };
    webviewPanel.webview.html = getWebviewHtml(
      webviewPanel.webview,
      this.context.extensionUri
    );

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(document, webviewPanel, message);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`PDF Viewer: ${messageText}`);
        void webviewPanel.webview.postMessage({
          type: 'operation-error',
          message: messageText
        });
      }
    });
  }

  /**
   * The webview protocol is deliberately allow-listed. Update, command,
   * export, and serialization messages are not accepted.
   *
   * @param {PdfDocument} document
   * @param {vscode.WebviewPanel} panel
   * @param {Record<string, unknown>} message
   */
  async handleMessage(document, panel, message) {
    if (message.type === 'ready') {
      await this.sendDocument(panel, document);
      return;
    }

    if (message.type === 'show-message') {
      await this.showMessage(message);
      return;
    }

    throw new Error('This PDF viewer is read-only. Editing commands are disabled.');
  }

  /**
   * @param {Record<string, unknown>} message
   */
  async showMessage(message) {
    const text = String(message.message || '');
    if (!text) {
      return;
    }

    if (message.level === 'error') {
      await vscode.window.showErrorMessage(text);
    } else if (message.level === 'warning') {
      await vscode.window.showWarningMessage(text);
    } else {
      await vscode.window.showInformationMessage(text);
    }
  }

  /**
   * @param {vscode.WebviewPanel} panel
   * @param {PdfDocument} document
   */
  async sendDocument(panel, document) {
    const configuration = vscode.workspace.getConfiguration('pdfViewerEditor', document.uri);
    await panel.webview.postMessage({
      type: 'load-document',
      data: bytesToBase64(document.data),
      fileName: path.basename(document.uri.fsPath || document.uri.path),
      settings: {
        defaultZoom: configuration.get('defaultZoom', 1),
        maxRenderPixels: configuration.get('maxRenderPixels', 24000000)
      }
    });
  }

  dispose() {
    // The provider owns no mutable document state or background resources.
  }
}

module.exports = {
  PdfViewerProvider,
  VIEW_TYPE
};
