export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeRect(rect) {
  const [x0, y0, x1, y1] = rect;
  return [
    Math.min(x0, x1),
    Math.min(y0, y1),
    Math.max(x0, x1),
    Math.max(y0, y1)
  ];
}

export function rectFromBbox(bbox) {
  if (Array.isArray(bbox)) {
    return normalizeRect(bbox);
  }

  if (!bbox || typeof bbox !== 'object') {
    return [0, 0, 0, 0];
  }

  const x = Number(bbox.x || 0);
  const y = Number(bbox.y || 0);
  const width = Number(bbox.w || bbox.width || 0);
  const height = Number(bbox.h || bbox.height || 0);
  return normalizeRect([x, y, x + width, y + height]);
}

export function rectToObject(rect) {
  const normalized = normalizeRect(rect);
  return {
    x: normalized[0],
    y: normalized[1],
    width: normalized[2] - normalized[0],
    height: normalized[3] - normalized[1]
  };
}

export function quadToRect(quad) {
  const xValues = [quad[0], quad[2], quad[4], quad[6]];
  const yValues = [quad[1], quad[3], quad[5], quad[7]];
  return [
    Math.min(...xValues),
    Math.min(...yValues),
    Math.max(...xValues),
    Math.max(...yValues)
  ];
}

export function rectToQuad(rect) {
  const [x0, y0, x1, y1] = normalizeRect(rect);
  return [x0, y0, x1, y0, x0, y1, x1, y1];
}

export function transformPoint(matrix, point) {
  return [
    point[0] * matrix[0] + point[1] * matrix[2] + matrix[4],
    point[0] * matrix[1] + point[1] * matrix[3] + matrix[5]
  ];
}

export function invertMatrix(matrix) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < 1e-9) {
    throw new Error('Cannot invert a singular transformation matrix.');
  }
  return [
    matrix[3] / determinant,
    -matrix[1] / determinant,
    -matrix[2] / determinant,
    matrix[0] / determinant,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant
  ];
}

export function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function hexToPdfColor(value) {
  const normalized = String(value || '#000000').replace('#', '').padEnd(6, '0');
  return [
    Number.parseInt(normalized.slice(0, 2), 16) / 255,
    Number.parseInt(normalized.slice(2, 4), 16) / 255,
    Number.parseInt(normalized.slice(4, 6), 16) / 255
  ];
}

export function pdfColorToHex(color, fallback = '#000000') {
  if (!Array.isArray(color) || color.length === 0) {
    return fallback;
  }

  let rgb;
  if (color.length === 1) {
    rgb = [color[0], color[0], color[0]];
  } else if (color.length >= 3) {
    rgb = color.slice(0, 3);
  } else {
    return fallback;
  }

  return `#${rgb
    .map((component) => Math.round(clamp(component, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0'))
    .join('')}`;
}

export function parsePageRange(value, pageCount) {
  const pages = new Set();
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('Enter at least one page number.');
  }

  for (const part of normalized.split(',')) {
    const token = part.trim();
    if (!token) {
      continue;
    }

    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) {
        throw new Error(`Invalid descending page range: ${token}.`);
      }
      for (let page = start; page <= end; page += 1) {
        validatePageNumber(page, pageCount);
        pages.add(page - 1);
      }
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new Error(`Invalid page expression: ${token}.`);
    }
    const page = Number(token);
    validatePageNumber(page, pageCount);
    pages.add(page - 1);
  }

  return [...pages];
}

function validatePageNumber(page, pageCount) {
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new Error(`Page ${page} is outside the document (1-${pageCount}).`);
  }
}

export function sanitizeFileStem(value) {
  return String(value || 'document')
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((character) => character.charCodeAt(0) < 32 ? '_' : character)
    .join('')
    .trim() || 'document';
}

export function fileToBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'));
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.readAsArrayBuffer(file);
  });
}

export function uint8ArrayToBlobUrl(bytes, mimeType) {
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
