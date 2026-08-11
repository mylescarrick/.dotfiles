import type { NormalizedSearchResult, SearchProvider, SearchProviderError } from "./providers/types.ts";
import { err, ok, type Result } from "./result.ts";
import type { SearchDepth, SearchProviderName, SearchQuery, WebToolsSettings } from "./types.ts";

export interface SearchWebInput {
  readonly depth: SearchDepth;
  readonly maxResults: number;
  readonly query: SearchQuery;
}

export interface SearchWebResult {
  readonly depth: SearchDepth;
  readonly maxResults: number;
  readonly provider: SearchProviderName;
  readonly query: SearchQuery;
  readonly results: readonly NormalizedSearchResult[];
}

export type SearchWebError = { readonly _tag: "SearchDisabled" } | SearchProviderError;

export interface SearchWebDependencies {
  readonly provider: SearchProvider;
  readonly settings: WebToolsSettings["search"];
}

export class SearchWeb {
  constructor(private readonly dependencies: SearchWebDependencies) {}

  /** Execute a web search through the configured provider. */
  async search(
    input: SearchWebInput,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Result<SearchWebResult, SearchWebError>> {
    if (!this.dependencies.settings.enabled) {
      return err({ _tag: "SearchDisabled" });
    }

    const providerResult = await this.dependencies.provider.search(input, { signal: options.signal });
    if (providerResult._tag === "err") {
      return providerResult;
    }

    return ok({
      depth: input.depth,
      maxResults: input.maxResults,
      provider: this.dependencies.provider.name,
      query: input.query,
      results: providerResult.value,
    });
  }
}
