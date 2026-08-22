import { parsePublicHttpUrl } from "../types.ts";
import type { NormalizedSearchResult } from "./types.ts";

export type ExaResultsParseError =
  | { readonly _tag: "NoRecognizedResults" }
  | { readonly _tag: "MalformedResultSection"; readonly reason: string };

export interface ParseExaSearchTextResult {
  readonly discardedSections: number;
  readonly explicitNoResults: boolean;
  readonly results: readonly NormalizedSearchResult[];
}

/** Parse Exa's untrusted text search-result format into normalized results. */
export function parseExaSearchText(input: string): ParseExaSearchTextResult {
  const trimmed = input.replace(/\r\n/g, "\n").trim();
  if (!trimmed) {
    return { discardedSections: 0, explicitNoResults: true, results: [] };
  }

  const explicitNoResults = isExplicitNoResultsText(trimmed);
  if (explicitNoResults) {
    return { discardedSections: 0, explicitNoResults, results: [] };
  }

  const sections = splitSearchSections(trimmed);
  const results: NormalizedSearchResult[] = [];
  let discardedSections = 0;

  for (const section of sections) {
    const parsed = parseSearchSection(section);
    if (!parsed) {
      discardedSections += 1;
      continue;
    }
    results.push(parsed);
  }

  return { discardedSections, explicitNoResults, results };
}

function splitSearchSections(input: string): string[] {
  const lines = input.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let sawUrlOrText = false;

  for (const line of lines) {
    if (line.startsWith("Title: ") && current.length > 0 && sawUrlOrText) {
      sections.push(current.join("\n").trim());
      current = [line];
      sawUrlOrText = false;
      continue;
    }
    if (line.startsWith("URL: ") || line.startsWith("Text:") || line.startsWith("Highlights:")) {
      sawUrlOrText = true;
    }
    current.push(line);
  }

  if (current.length > 0) {
    sections.push(current.join("\n").trim());
  }

  return sections.filter((section) => section.length > 0);
}

interface SectionFields {
  publishedAt?: string;
  score?: number;
  source?: string;
  title: string;
  url: string;
}

/** Metadata lines Exa emits before the free-text body. Order matters: the first matching prefix wins. */
const METADATA_HANDLERS: readonly {
  readonly prefix: string;
  readonly apply: (fields: SectionFields, value: string) => void;
}[] = [
  {
    apply: (fields, value) => {
      fields.title = value.trim();
    },
    prefix: "Title: ",
  },
  {
    apply: (fields, value) => {
      fields.url = value.trim();
    },
    prefix: "URL: ",
  },
  {
    apply: (fields, value) => {
      fields.publishedAt = normalizeMetadataValue(value);
    },
    prefix: "Published Date: ",
  },
  {
    apply: (fields, value) => {
      fields.publishedAt = normalizeMetadataValue(value);
    },
    prefix: "Published: ",
  },
  {
    apply: (fields, value) => {
      fields.source = normalizeMetadataValue(value);
    },
    prefix: "Source: ",
  },
  {
    // Author is only a fallback for an absent explicit Source.
    apply: (fields, value) => {
      if (!fields.source) fields.source = normalizeMetadataValue(value);
    },
    prefix: "Author: ",
  },
  {
    apply: (fields, value) => {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) fields.score = parsed;
    },
    prefix: "Score: ",
  },
];

/** Once one of these appears, every remaining line is body text rather than metadata. */
const BODY_PREFIXES = ["Text:", "Highlights:"] as const;

function parseSectionLines(lines: readonly string[]): {
  fields: SectionFields;
  snippetLines: string[];
} {
  const fields: SectionFields = { title: "", url: "" };
  const snippetLines: string[] = [];
  let inBody = false;

  for (const line of lines) {
    if (inBody) {
      snippetLines.push(line);
      continue;
    }
    const bodyPrefix = BODY_PREFIXES.find((prefix) => line.startsWith(prefix));
    if (bodyPrefix) {
      inBody = true;
      snippetLines.push(line.slice(bodyPrefix.length).trim());
      continue;
    }
    const handler = METADATA_HANDLERS.find((entry) => line.startsWith(entry.prefix));
    if (handler) handler.apply(fields, line.slice(handler.prefix.length));
  }

  return { fields, snippetLines };
}

function parseSearchSection(section: string): NormalizedSearchResult | undefined {
  const { fields, snippetLines } = parseSectionLines(section.split("\n"));
  if (!fields.url) return undefined;

  const parsedUrl = parsePublicHttpUrl(fields.url);
  if (parsedUrl._tag === "err") return undefined;

  return {
    publishedAt: fields.publishedAt,
    score: fields.score,
    snippet: summarizeSnippet(snippetLines.join("\n"), fields.title),
    source: fields.source,
    title: fields.title || parsedUrl.value,
    url: parsedUrl.value,
  };
}

function summarizeSnippet(text: string, title: string): string | undefined {
  const collapsed = text
    .replace(/\r\n/g, "\n")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!collapsed) return undefined;

  let snippet = collapsed;
  if (title) {
    snippet = stripRepeatedLeadingTitle(snippet, title);
  }
  if (!snippet) snippet = collapsed;
  if (snippet.length <= 280) return snippet;
  return `${snippet.slice(0, 277).trimEnd()}...`;
}

function stripRepeatedLeadingTitle(snippet: string, title: string): string {
  const normalizedTitle = title.trim().toLowerCase();
  let current = snippet.trim();
  while (current) {
    const lines = current.split("\n");
    const firstIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstIndex === -1) return current.trim();
    if (lines[firstIndex]?.trim().toLowerCase() !== normalizedTitle) {
      return current.trim();
    }
    current = lines
      .slice(firstIndex + 1)
      .join("\n")
      .trim();
  }
  return current.trim();
}

function normalizeMetadataValue(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;

  const lowered = normalized.toLowerCase();
  if (["n/a", "na", "none", "null", "undefined", "unknown"].includes(lowered)) {
    return undefined;
  }

  return normalized;
}

function isExplicitNoResultsText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized === "no results found" ||
    normalized.startsWith("no results found") ||
    normalized.includes("no relevant results")
  );
}
