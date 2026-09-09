'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const vendorRoot = path.join(projectRoot, 'media', 'vendor');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function copyFile(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required vendor file not found: ${source}`);
  }

  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function copyVendors() {
  fs.rmSync(vendorRoot, { recursive: true, force: true });

  const mupdfRoot = path.join(projectRoot, 'node_modules', 'mupdf');
  const mupdfDestination = path.join(vendorRoot, 'mupdf');
  for (const fileName of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) {
    copyFile(
      path.join(mupdfRoot, 'dist', fileName),
      path.join(mupdfDestination, fileName)
    );
  }
  copyFile(
    path.join(mupdfRoot, 'LICENSE'),
    path.join(mupdfDestination, 'LICENSE')
  );

  console.log('Vendor assets copied to media/vendor.');
}

copyVendors();
