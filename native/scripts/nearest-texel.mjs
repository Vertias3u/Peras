import assert from 'node:assert/strict';

// Only an EXACT rational boundary has two equally-near source texels.
// No epsilon, colour tolerance or arbitrary neighbourhood search is permitted.
export function nearestAxis(pixel, sourceLength, outputLength) {
  assert.ok([pixel, sourceLength, outputLength].every(Number.isSafeInteger));
  assert.ok(pixel >= 0 && pixel < outputLength && sourceLength > 0);
  const numerator = (2 * pixel + 1) * sourceLength, denominator = 2 * outputLength;
  assert.ok(Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator));
  const upper = Math.min(sourceLength - 1, Math.floor(numerator / denominator));
  return numerator % denominator === 0 && upper > 0 ? [upper, upper - 1] : [upper];
}
export function nearestTexels(x, y, sourceWidth, sourceHeight, outputWidth, outputHeight, flipped) {
  return nearestAxis(x, sourceWidth, outputWidth).flatMap(sx =>
    nearestAxis(y, sourceHeight, outputHeight).map(sy => [flipped ? sourceWidth - 1 - sx : sx, sy]));
}
