export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
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

export function transformPoint(matrix, point) {
  return [
    point[0] * matrix[0] + point[1] * matrix[2] + matrix[4],
    point[0] * matrix[1] + point[1] * matrix[3] + matrix[5]
  ];
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
