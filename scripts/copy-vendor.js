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

function copyMatchingFiles(sourceDirectory, destinationDirectory, matcher) {
  ensureDirectory(destinationDirectory);

  for (const fileName of fs.readdirSync(sourceDirectory)) {
    if (matcher(fileName)) {
      copyFile(
        path.join(sourceDirectory, fileName),
        path.join(destinationDirectory, fileName)
      );
    }
  }
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

  const fabricRoot = path.join(projectRoot, 'node_modules', 'fabric');
  const fabricDestination = path.join(vendorRoot, 'fabric');
  copyFile(
    path.join(fabricRoot, 'dist', 'index.min.js'),
    path.join(fabricDestination, 'fabric.min.js')
  );
  copyFile(
    path.join(fabricRoot, 'LICENSE'),
    path.join(fabricDestination, 'LICENSE')
  );

  const tesseractRoot = path.join(projectRoot, 'node_modules', 'tesseract.js');
  const tesseractDestination = path.join(vendorRoot, 'tesseract');
  for (const fileName of ['tesseract.min.js', 'worker.min.js']) {
    copyFile(
      path.join(tesseractRoot, 'dist', fileName),
      path.join(tesseractDestination, fileName)
    );
  }
  copyFile(
    path.join(tesseractRoot, 'LICENSE.md'),
    path.join(tesseractDestination, 'LICENSE')
  );

  const tesseractCoreRoot = path.join(projectRoot, 'node_modules', 'tesseract.js-core');
  const tesseractCoreDestination = path.join(tesseractDestination, 'core');
  copyMatchingFiles(
    tesseractCoreRoot,
    tesseractCoreDestination,
    (fileName) => fileName.startsWith('tesseract-core') && (
      fileName.endsWith('.js') || fileName.endsWith('.wasm')
    )
  );

  const languageDestination = path.join(tesseractDestination, 'languages');
  for (const language of ['spa', 'eng']) {
    copyFile(
      path.join(
        projectRoot,
        'node_modules',
        '@tesseract.js-data',
        language,
        '4.0.0_best_int',
        `${language}.traineddata.gz`
      ),
      path.join(languageDestination, `${language}.traineddata.gz`)
    );
  }

  console.log('Vendor assets copied to media/vendor.');
}

copyVendors();
