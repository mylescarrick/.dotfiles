import assert from "node:assert/strict";
import test from "node:test";
import type {
  NormalizedSearchResult,
  SearchProvider,
  SearchProviderError,
  SearchProviderRequest,
} from "../providers/types.ts";
import { err, ok, type Result } from "../result.ts";
import { SearchWeb } from "../search-web.ts";
import type { ToolOutputStore, ToolOutputStoreError } from "../tool-output.ts";
import type { WebToolsSettings } from "../types.ts";
import { parsePublicHttpUrl } from "../types.ts";
import { createWebSearchTool } from "../websearch.ts";

const endpoint = parsePublicHttpUrl("https://example.test/mcp");
assert.equal(endpoint._tag, "ok");

const settings: WebToolsSettings = {
  fetch: {
    blockPrivateHosts: true,
    defaultFormat: "markdown",
    fallbackUserAgent: "opencode",
    maxRedirects: 5,
    maxResponseBytes: 5 * 1024 * 1024,
    timeoutSeconds: 30,
  },
  search: {
    defaultDepth: "auto",
    defaultMaxResults: 8,
    enabled: true,
    endpoint: endpoint.value,
    provider: "exa",
    timeoutSeconds: 25,
  },
};

class FakeProvider implements SearchProvider {
  readonly name = "exa" as const;

  constructor(private readonly response: Result<readonly NormalizedSearchResult[], SearchProviderError>) {}

  async search(
    _input: SearchProviderRequest,
    _options?: { readonly signal?: AbortSignal }
  ): Promise<Result<readonly NormalizedSearchResult[], SearchProviderError>> {
    return this.response;
  }
}

class UnusedOutputStore implements ToolOutputStore {
  async writeTextFile(
    _prefix: string,
    _fileName: string,
    _content: string
  ): Promise<Result<string, ToolOutputStoreError>> {
    return ok("/tmp/unused.txt");
  }
}

test("websearch execute throws safe message for provider protocol failures", async () => {
  const searchWeb = new SearchWeb({
    provider: new FakeProvider(
      err({
        _tag: "SearchProviderProtocolInvalid",
        provider: "exa",
        reason: "missing result content raw details",
      })
    ),
    settings: settings.search,
  });
  const tool = createWebSearchTool({ outputStore: new UnusedOutputStore(), searchWeb, settings });

  await assert.rejects(
    tool.execute("id", { query: "example" }),
    /Search provider returned an invalid response/
  );
});
