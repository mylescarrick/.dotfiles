import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { FetchPageResult } from "./fetch-page.ts";
import type { NormalizedSearchResult } from "./providers/types.ts";
import { err, ok, type Result } from "./result.ts";
import type { SearchWebResult } from "./search-web.ts";
import { writeTempTextFile } from "./temp.ts";
import type { SearchDepth, SearchProviderName, WebFetchFormat } from "./types.ts";

export interface ToolOutputStore {
  writeTextFile: (
    prefix: string,
    fileName: string,
    content: string
  ) => Promise<Result<string, ToolOutputStoreError>>;
}

export interface ToolOutputStoreError {
  readonly _tag: "TempFileWriteFailed";
  readonly cause: unknown;
}

export class TempFileToolOutputStore implements ToolOutputStore {
  /** Write full tool output to a temporary text file. */
  async writeTextFile(
    prefix: string,
    fileName: string,
    content: string
  ): Promise<Result<string, ToolOutputStoreError>> {
    try {
      return ok(await writeTempTextFile(prefix, fileName, content));
    } catch (cause: unknown) {
      return err({ _tag: "TempFileWriteFailed", cause });
    }
  }
}

export interface PiTextContent {
  readonly text: string;
  readonly type: "text";
}
export interface PiImageContent {
  readonly data: string;
  readonly mimeType: string;
  readonly type: "image";
}

export interface PiToolResult<Details> {
  readonly content: Array<PiTextContent | PiImageContent>;
  readonly details: Details;
}

export interface WebFetchDetails {
  readonly bytes: number;
  readonly charset?: string;
  readonly contentType: string;
  readonly decoder?: string;
  readonly finalUrl: string;
  readonly format: WebFetchFormat;
  readonly fullOutputPath?: string;
  readonly image?: boolean;
  readonly mime: string;
  readonly requestedUrl: string;
  readonly status: number;
  readonly truncated?: boolean;
}

export interface WebSearchDetails {
  readonly depth: SearchDepth;
  readonly fullOutputPath?: string;
  readonly maxResults: number;
  readonly provider: SearchProviderName;
  readonly query: string;
  readonly resultCount: number;
  readonly results: readonly NormalizedSearchResult[];
  readonly truncated?: boolean;
}

interface ProjectedTextOutput {
  readonly fullOutputPath?: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly truncation: TruncationResult;
}

/** Project a fetch-page service result to a Pi tool result with truncation protection. */
export async function projectFetchPageResultToPiToolResult(
  result: FetchPageResult,
  store: ToolOutputStore
): Promise<Result<PiToolResult<WebFetchDetails>, ToolOutputStoreError>> {
  if (result._tag === "Image") {
    return ok({
      content: [
        textContent(
          `Fetched image from ${result.finalUrl} (${result.mime || "image"}, ${formatSize(result.bytes)})`
        ),
        imageContent(result.data.toString("base64"), result.mime),
      ],
      details: {
        bytes: result.bytes,
        contentType: result.contentType,
        finalUrl: result.finalUrl,
        format: result.format,
        image: true,
        mime: result.mime,
        requestedUrl: result.requestedUrl,
        status: result.status,
      },
    });
  }

  const truncated = await projectTextOutput(result.text, {
    fileName: "output.txt",
    store,
    tempPrefix: "pi-webfetch-",
  });
  if (truncated._tag === "err") {
    return truncated;
  }

  return ok({
    content: [textContent(truncated.value.text)],
    details: {
      bytes: result.bytes,
      charset: result.charset,
      contentType: result.contentType,
      decoder: result.decoder,
      finalUrl: result.finalUrl,
      format: result.format,
      fullOutputPath: truncated.value.fullOutputPath,
      mime: result.mime,
      requestedUrl: result.requestedUrl,
      status: result.status,
      truncated: truncated.value.truncated,
    },
  });
}

/** Project a search-web service result to a Pi tool result with truncation protection. */
export async function projectSearchWebResultToPiToolResult(
  result: SearchWebResult,
  store: ToolOutputStore
): Promise<Result<PiToolResult<WebSearchDetails>, ToolOutputStoreError>> {
  const output = formatSearchResults(result.query, result.results);
  const truncated = await projectTextOutput(output, {
    fileName: "output.txt",
    store,
    tempPrefix: "pi-websearch-",
  });
  if (truncated._tag === "err") {
    return truncated;
  }

  return ok({
    content: [textContent(truncated.value.text)],
    details: {
      depth: result.depth,
      fullOutputPath: truncated.value.fullOutputPath,
      maxResults: result.maxResults,
      provider: result.provider,
      query: result.query,
      resultCount: result.results.length,
      results: result.results,
      truncated: truncated.value.truncated,
    },
  });
}

/** Format normalized search results as URL-forward text for LLM consumption. */
export function formatSearchResults(query: string, results: readonly NormalizedSearchResult[]): string {
  if (results.length === 0) {
    return `Search results for: ${query}\n\nNo results found.`;
  }

  const lines = [`Search results for: ${query}`, ""];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   URL: ${result.url}`);
    if (result.publishedAt) {
      lines.push(`   Published: ${result.publishedAt}`);
    }
    if (result.source) {
      lines.push(`   Source: ${result.source}`);
    }
    if (typeof result.score === "number") {
      lines.push(`   Score: ${result.score}`);
    }
    if (result.snippet) {
      lines.push(`   Snippet: ${result.snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function projectTextOutput(
  output: string,
  options: { readonly store: ToolOutputStore; readonly tempPrefix: string; readonly fileName: string }
): Promise<Result<ProjectedTextOutput, ToolOutputStoreError>> {
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) {
    return ok({ text: truncation.content, truncated: false, truncation });
  }

  const fullOutputPath = await options.store.writeTextFile(options.tempPrefix, options.fileName, output);
  if (fullOutputPath._tag === "err") {
    return fullOutputPath;
  }

  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  let text = truncation.content;
  text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`;
  text += ` Full output saved to: ${fullOutputPath.value}]`;

  return ok({ fullOutputPath: fullOutputPath.value, text, truncated: true, truncation });
}

function textContent(text: string): PiTextContent {
  return { text, type: "text" };
}

function imageContent(data: string, mimeType: string): PiImageContent {
  return { data, mimeType, type: "image" };
}
