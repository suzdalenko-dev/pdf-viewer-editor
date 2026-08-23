'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { base64ToBytes, bytesToBase64 } = require('./base64');
const { PdfDocument } = require('./pdf-document');
const { getWebviewHtml } = require('./webview-html');

const VIEW_TYPE = 'pdfViewerEditor.editor';

class PdfEditorProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this._onDidChangeCustomDocument = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
    /** @type {Map<PdfDocument, Set<vscode.WebviewPanel>>} */
    this.panels = new Map();
  }

  /**
   * @param {vscode.Uri} uri
   * @param {vscode.CustomDocumentOpenContext} openContext
   * @param {vscode.CancellationToken} _token
   * @returns {Promise<PdfDocument>}
   */
  async openCustomDocument(uri, openContext, _token) {
    const sourceUri = openContext.backupId
      ? vscode.Uri.parse(openContext.backupId)
      : uri;
    const data = await vscode.workspace.fs.readFile(sourceUri);
    const document = new PdfDocument(uri, data);
    document.onDidDispose(() => this.panels.delete(document));
    return document;
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

    let documentPanels = this.panels.get(document);
    if (!documentPanels) {
      documentPanels = new Set();
      this.panels.set(document, documentPanels);
    }
    documentPanels.add(webviewPanel);

    webviewPanel.onDidDispose(() => {
      const panels = this.panels.get(document);
      panels?.delete(webviewPanel);
      if (panels?.size === 0) {
        this.panels.delete(document);
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(document, webviewPanel, message);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`PDF Viewer & Editor: ${messageText}`);
        void webviewPanel.webview.postMessage({
          type: 'operation-error',
          message: messageText
        });
      }
    });
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.WebviewPanel} panel
   * @param {Record<string, unknown>} message
   */
  async handleMessage(document, panel, message) {
    switch (message.type) {
      case 'ready':
        await this.sendDocument(panel, document);
        return;

      case 'document-edited': {
        if (typeof message.data !== 'string' || typeof message.label !== 'string') {
          throw new Error('The editor returned an invalid PDF update.');
        }

        if (Number(message.baseRevision) !== document.revision) {
          await this.sendDocument(panel, document);
          throw new Error('The PDF changed in another editor. The latest version was reloaded.');
        }

        const nextData = base64ToBytes(message.data);
        this.applyEdit(document, message.label, nextData);
        await this.broadcastDocument(document, panel);
        return;
      }

      case 'command':
        await this.executeEditorCommand(String(message.command || ''));
        return;

      case 'export':
        await this.exportFile(message);
        return;

      case 'show-message':
        await this.showMessage(message);
        return;

      default:
        return;
    }
  }

  /**
   * @param {PdfDocument} document
   * @param {string} label
   * @param {Uint8Array} nextData
   */
  applyEdit(document, label, nextData) {
    const previousData = document.data;
    document.replaceData(nextData);

    this._onDidChangeCustomDocument.fire({
      document,
      label,
      undo: async () => {
        document.replaceData(previousData);
        await this.broadcastDocument(document);
      },
      redo: async () => {
        document.replaceData(nextData);
        await this.broadcastDocument(document);
      }
    });
  }

  /**
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
  }

  /**
   * @param {Record<string, unknown>} message
   */
  async exportFile(message) {
    if (typeof message.data !== 'string') {
      throw new Error('Export data is missing.');
    }

    const suggestedName = sanitizeFileName(String(message.suggestedName || 'export.pdf'));
    const extension = path.extname(suggestedName).slice(1) || 'pdf';
    const destination = await vscode.window.showSaveDialog({
      saveLabel: 'Export',
      defaultUri: vscode.Uri.file(path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
        suggestedName
      )),
      filters: {
        [extension.toUpperCase()]: [extension]
      }
    });

    if (destination) {
      await vscode.workspace.fs.writeFile(destination, base64ToBytes(message.data));
      void vscode.window.showInformationMessage(`Exported ${path.basename(destination.fsPath)}.`);
    }
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
      revision: document.revision,
      fileName: path.basename(document.uri.fsPath || document.uri.path),
      settings: {
        defaultZoom: configuration.get('defaultZoom', 1.25),
        maxRenderPixels: configuration.get('maxRenderPixels', 24000000),
        defaultSaveMode: configuration.get('defaultSaveMode', 'incremental'),
        ocrLanguageDataUrl: configuration.get(
          'ocrLanguageDataUrl',
          'https://tessdata.projectnaptha.com/4.0.0_best_int'
        )
      }
    });
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.WebviewPanel} [excludedPanel]
   */
  async broadcastDocument(document, excludedPanel) {
    const panels = this.panels.get(document);
    if (!panels) {
      return;
    }

    await Promise.all(
      [...panels]
        .filter((panel) => panel !== excludedPanel)
        .map((panel) => this.sendDocument(panel, document))
    );
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.CancellationToken} _cancellation
   */
  async saveCustomDocument(document, _cancellation) {
    await vscode.workspace.fs.writeFile(document.uri, document.data);
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.Uri} destination
   * @param {vscode.CancellationToken} _cancellation
   */
  async saveCustomDocumentAs(document, destination, _cancellation) {
    await vscode.workspace.fs.writeFile(destination, document.data);
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.CancellationToken} _cancellation
   */
  async revertCustomDocument(document, _cancellation) {
    const data = await vscode.workspace.fs.readFile(document.uri);
    document.replaceData(data);
    await this.broadcastDocument(document);
  }

  /**
   * @param {PdfDocument} document
   * @param {vscode.CustomDocumentBackupContext} context
   * @param {vscode.CancellationToken} _cancellation
   * @returns {Promise<vscode.CustomDocumentBackup>}
   */
  async backupCustomDocument(document, context, _cancellation) {
    await vscode.workspace.fs.writeFile(context.destination, document.data);
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // VS Code may already have removed an obsolete backup.
        }
      }
    };
  }

  dispose() {
    this._onDidChangeCustomDocument.dispose();
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function sanitizeFileName(value) {
  return value
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('');
}

module.exports = {
  PdfEditorProvider,
  VIEW_TYPE,
  sanitizeFileName
};
