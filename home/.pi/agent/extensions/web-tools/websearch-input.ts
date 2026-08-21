import { err, ok, type Result } from "./result.ts";
import {
  clampInteger,
  SEARCH_DEPTHS,
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_SECONDS,
  type ToolInputParseError,
} from "./settings.ts";
import {
  type ParseSearchQueryError,
  parseSearchQuery,
  type SearchDepth,
  type SearchQuery,
  type WebToolsSettings,
} from "./types.ts";

export interface RawWebSearchToolParams {
  readonly depth?: SearchDepth;
  readonly maxResults?: number;
  readonly query: string;
}

export interface WebSearchToolInput {
  readonly depth: SearchDepth;
  readonly maxResults: number;
  readonly query: SearchQuery;
  readonly timeoutSeconds: number;
}

/** Parse raw Pi websearch params into service-facing input. */
export function parseWebSearchToolParams(
  raw: unknown,
  settings: WebToolsSettings["search"]
): Result<WebSearchToolInput, ToolInputParseError | ParseSearchQueryError> {
  if (!isPlainObject(raw)) {
    return err({ _tag: "InvalidToolInput", message: "Expected an object" });
  }

  for (const key of Object.keys(raw)) {
    if (key !== "query" && key !== "maxResults" && key !== "depth") {
      return err({ _tag: "UnknownToolField", field: key });
    }
  }

  const queryValue = raw.query;
  if (typeof queryValue !== "string") {
    return err({ _tag: "InvalidToolField", field: "query", message: "Expected a string" });
  }

  const query = parseSearchQuery(queryValue);
  if (query._tag === "err") {
    return query;
  }

  const maxResultsValue = raw.maxResults;
  let maxResults = clampInteger(settings.defaultMaxResults, {
    fallback: SEARCH_MAX_RESULTS.default,
    max: SEARCH_MAX_RESULTS.max,
    min: SEARCH_MAX_RESULTS.min,
  });
  if (maxResultsValue !== undefined) {
    if (typeof maxResultsValue !== "number" || !Number.isFinite(maxResultsValue)) {
      return err({ _tag: "InvalidToolField", field: "maxResults", message: "Expected a finite number" });
    }
    maxResults = clampInteger(maxResultsValue, {
      fallback: SEARCH_MAX_RESULTS.default,
      max: SEARCH_MAX_RESULTS.max,
      min: SEARCH_MAX_RESULTS.min,
    });
  }

  const depthValue = raw.depth;
  let depth = settings.defaultDepth;
  if (depthValue !== undefined) {
    if (typeof depthValue !== "string" || !isSearchDepth(depthValue)) {
      return err({ _tag: "InvalidToolField", field: "depth", message: "Expected one of: auto, fast, deep" });
    }
    depth = depthValue;
  }

  const timeoutSeconds = clampInteger(settings.timeoutSeconds, {
    fallback: SEARCH_TIMEOUT_SECONDS.default,
    max: SEARCH_TIMEOUT_SECONDS.max,
    min: SEARCH_TIMEOUT_SECONDS.min,
  });

  return ok({ depth, maxResults, query: query.value, timeoutSeconds });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchDepth(value: string): value is SearchDepth {
  const depths: readonly string[] = SEARCH_DEPTHS;
  return depths.includes(value);
}
