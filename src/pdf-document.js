'use strict';

class PdfDocument {
  /**
   * @param {import('vscode').Uri} uri
   * @param {Uint8Array} data
   */
  constructor(uri, data) {
    this.uri = uri;
    this._data = data.slice();
  }

  /** @returns {Uint8Array} */
  get data() {
    return this._data.slice();
  }

  dispose() {
    // The immutable byte snapshot is released with the document instance.
  }
}

module.exports = {
  PdfDocument
};
