import assert from "node:assert/strict";
import test from "node:test";
import type {
  NormalizedSearchResult,
  SearchProvider,
  SearchProviderError,
  SearchProviderRequest,
} from "../providers/types.ts";
import { ok, type Result } from "../result.ts";
import { SearchWeb } from "../search-web.ts";
import { parsePublicHttpUrl, parseSearchQuery, type WebToolsSettings } from "../types.ts";

const endpoint = parsePublicHttpUrl("https://example.test/mcp");
assert.equal(endpoint._tag, "ok");

const testSearchSettings: WebToolsSettings["search"] = {
  defaultDepth: "auto",
  defaultMaxResults: 8,
  enabled: true,
  endpoint: endpoint.value,
  provider: "exa",
  timeoutSeconds: 25,
};

class FakeSearchProvider implements SearchProvider {
  readonly name = "exa" as const;
  readonly requests: SearchProviderRequest[] = [];

  constructor(private readonly response: Result<readonly NormalizedSearchResult[], SearchProviderError>) {}

  async search(
    input: SearchProviderRequest,
    _options?: { readonly signal?: AbortSignal }
  ): Promise<Result<readonly NormalizedSearchResult[], SearchProviderError>> {
    this.requests.push(input);
    return this.response;
  }
}

test("SearchWeb returns provider results with query metadata", async () => {
  const query = parseSearchQuery("example");
  const resultUrl = parsePublicHttpUrl("https://example.com/");
  assert.equal(query._tag, "ok");
  assert.equal(resultUrl._tag, "ok");
  const exampleResult: NormalizedSearchResult = {
    snippet: "Documentation-safe example domain.",
    title: "Example Domain",
    url: resultUrl.value,
  };
  const provider = new FakeSearchProvider(ok([exampleResult]));
  const service = new SearchWeb({ provider, settings: testSearchSettings });

  const result = await service.search({ depth: "auto", maxResults: 8, query: query.value });

  assert.equal(result._tag, "ok");
  assert.equal(result.value.provider, "exa");
  assert.equal(result.value.query, "example");
  assert.equal(result.value.results.length, 1);
});
