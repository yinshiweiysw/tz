export function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(Number(value).toFixed(digits));
}

export function roundOrNull(value, digits = 2) {
  const result = round(value, digits);
  return result;
}
