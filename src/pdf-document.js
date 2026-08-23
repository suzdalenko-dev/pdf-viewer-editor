'use strict';

const vscode = require('vscode');

class PdfDocument {
  /**
   * @param {vscode.Uri} uri
   * @param {Uint8Array} data
   */
  constructor(uri, data) {
    this.uri = uri;
    this._data = data.slice();
    this._revision = 0;
    this._disposed = false;
    /** @type {vscode.EventEmitter<void>} */
    this._onDidDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDidDispose.event;
  }

  /** @returns {Uint8Array} */
  get data() {
    return this._data.slice();
  }

  /** @returns {number} */
  get revision() {
    return this._revision;
  }

  /**
   * Replace the current binary representation and advance the revision.
   *
   * @param {Uint8Array} data
   * @returns {number}
   */
  replaceData(data) {
    if (this._disposed) {
      throw new Error('Cannot update a disposed PDF document.');
    }

    this._data = data.slice();
    this._revision += 1;
    return this._revision;
  }

  dispose() {
    if (this._disposed) {
      return;
    }

    this._disposed = true;
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

module.exports = {
  PdfDocument
};
