const js = require('@eslint/js');

module.exports = [
  {
    ignores: [
      'eslint.config.js',
      'media/vendor/**',
      'node_modules/**',
      '*.vsix'
    ]
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        Buffer: 'readonly',
        __dirname: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all']
    }
  },
  {
    files: ['media/webview/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        acquireVsCodeApi: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        Blob: 'readonly',
        console: 'readonly',
        CustomEvent: 'readonly',
        document: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Image: 'readonly',
        ImageData: 'readonly',
        navigator: 'readonly',
        URL: 'readonly',
        Uint8Array: 'readonly',
        Uint8ClampedArray: 'readonly',
        window: 'readonly',
        fabric: 'readonly',
        Tesseract: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'all']
    }
  }
];
