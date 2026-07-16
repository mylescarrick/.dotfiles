export function parseJsonObject(
  text: string,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}
