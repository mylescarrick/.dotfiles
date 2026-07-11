import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

export function truncateForTool(text: string): { text: string; truncated: boolean; fullOutputPath?: string } {
  const lines = text.split("\n")
  const tooManyLines = lines.length > MAX_LINES
  const tooManyBytes = byteLength(text) > MAX_BYTES
  if (!tooManyLines && !tooManyBytes) return { text, truncated: false }

  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-"))
  const fullOutputPath = join(dir, "output.txt")
  writeFileSync(fullOutputPath, text, "utf8")

  let kept = lines.slice(Math.max(0, lines.length - MAX_LINES)).join("\n")
  while (byteLength(kept) > MAX_BYTES) {
    kept = kept.slice(Math.ceil(kept.length * 0.1))
  }

  return {
    text: `${kept}\n\n[Herdr output truncated. Full output saved to: ${fullOutputPath}]`,
    truncated: true,
    fullOutputPath,
  }
}
