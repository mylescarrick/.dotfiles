import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_STYLE = "Attention-kind";

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function stripFrontmatter(text: string): string {
  const normalized = normalizeLineEndings(text).replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return normalized.trimStart();
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (endIndex === -1) {
    return normalized.trimStart();
  }

  const bodyLines = lines.slice(endIndex + 1);

  while (bodyLines.length > 0 && bodyLines[0]?.trim() === "") {
    bodyLines.shift();
  }

  if (bodyLines[0]?.trim() === "<!-- body-start -->") {
    bodyLines.shift();
  }

  while (bodyLines.length > 0 && bodyLines[0]?.trim() === "") {
    bodyLines.shift();
  }

  return bodyLines.join("\n");
}

export function loadStyleFile(filePath: string): string {
  const raw = readFileSync(filePath, "utf8");
  return stripFrontmatter(raw).trimEnd();
}

export function loadStyle(name = DEFAULT_STYLE): string {
  const stylesDir = join(homedir(), ".claude", "output-styles");
  return loadStyleFile(join(stylesDir, `${name}.md`));
}
