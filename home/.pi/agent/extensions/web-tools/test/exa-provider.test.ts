import assert from "node:assert/strict";
import test from "node:test";
import {
  ExaSearchProvider,
  type HttpClientError,
  type HttpJsonRequest,
  type HttpTextClient,
  type HttpTextResponse,
} from "../providers/exa.ts";
import { ok, type Result } from "../result.ts";
import { parsePublicHttpUrl, parseSearchQuery } from "../types.ts";

const LEGACY_PROVIDER_TEXT = [
  "Title: Example Domain",
  "URL: https://example.com/",
  "Text: Example Domain",
  "",
  "Documentation-safe example domain.",
].join("\n");

class RecordingHttpTextClient implements HttpTextClient {
  readonly requests: HttpJsonRequest[] = [];

  constructor(private readonly response: Result<HttpTextResponse, HttpClientError>) {}

  async postJson(
    request: HttpJsonRequest,
    _options?: { readonly signal?: AbortSignal }
  ): Promise<Result<HttpTextResponse, HttpClientError>> {
    this.requests.push(request);
    return this.response;
  }
}

test("ExaSearchProvider sends fast when deep is requested", async () => {
  const http = new RecordingHttpTextClient(
    ok({
      bodyText: JSON.stringify({ result: { content: [{ text: LEGACY_PROVIDER_TEXT, type: "text" }] } }),
      bytes: 123,
      headers: new Headers({ "content-type": "application/json" }),
      status: 200,
      statusText: "OK",
    })
  );
  const endpoint = parsePublicHttpUrl("https://example.test/mcp");
  const query = parseSearchQuery("example");
  assert.equal(endpoint._tag, "ok");
  assert.equal(query._tag, "ok");

  const provider = new ExaSearchProvider(endpoint.value, http);
  const result = await provider.search({ depth: "deep", maxResults: 5, query: query.value });

  assert.equal(result._tag, "ok");
  assert.equal(result.value.length, 1);
  const requestBody = http.requests[0]?.body;
  assert.ok(isEncodedExaRequest(requestBody));
  assert.equal(requestBody.params.arguments.type, "fast");
});

test("ExaSearchProvider returns safe provider errors", async () => {
  const http = new RecordingHttpTextClient(
    ok({
      bodyText: `event: message\ndata: ${JSON.stringify({ result: { content: [{ text: "raw provider details", type: "text" }], isError: true } })}\n\n`,
      bytes: 123,
      headers: new Headers({ "content-type": "text/event-stream" }),
      status: 200,
      statusText: "OK",
    })
  );
  const endpoint = parsePublicHttpUrl("https://example.test/mcp");
  const query = parseSearchQuery("example");
  assert.equal(endpoint._tag, "ok");
  assert.equal(query._tag, "ok");

  const provider = new ExaSearchProvider(endpoint.value, http);
  const result = await provider.search({ depth: "fast", maxResults: 5, query: query.value });

  assert.deepEqual(result, {
    _tag: "err",
    error: {
      _tag: "SearchProviderReturnedError",
      provider: "exa",
      safeMessage: "Search provider returned an error",
    },
  });
});

test("ExaSearchProvider sends x-api-key when an api key ref is configured", async () => {
  const http = new RecordingHttpTextClient(
    ok({
      bodyText: JSON.stringify({ result: { content: [{ text: LEGACY_PROVIDER_TEXT, type: "text" }] } }),
      bytes: 123,
      headers: new Headers({ "content-type": "application/json" }),
      status: 200,
      statusText: "OK",
    })
  );
  const endpoint = parsePublicHttpUrl("https://example.test/mcp");
  const query = parseSearchQuery("example");
  assert.equal(endpoint._tag, "ok");
  assert.equal(query._tag, "ok");

  const provider = new ExaSearchProvider(endpoint.value, http, "literal-test-key");
  await provider.search({ depth: "auto", maxResults: 5, query: query.value });

  assert.equal(http.requests[0]?.headers["x-api-key"], "literal-test-key");
});

test("ExaSearchProvider omits x-api-key when no api key ref is configured", async () => {
  const http = new RecordingHttpTextClient(
    ok({
      bodyText: JSON.stringify({ result: { content: [{ text: LEGACY_PROVIDER_TEXT, type: "text" }] } }),
      bytes: 123,
      headers: new Headers({ "content-type": "application/json" }),
      status: 200,
      statusText: "OK",
    })
  );
  const endpoint = parsePublicHttpUrl("https://example.test/mcp");
  const query = parseSearchQuery("example");
  assert.equal(endpoint._tag, "ok");
  assert.equal(query._tag, "ok");

  const provider = new ExaSearchProvider(endpoint.value, http);
  await provider.search({ depth: "auto", maxResults: 5, query: query.value });

  assert.equal("x-api-key" in http.requests[0]!.headers, false);
});

function isEncodedExaRequest(
  value: unknown
): value is { readonly params: { readonly arguments: { readonly type: string } } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null &&
    "arguments" in value.params &&
    typeof value.params.arguments === "object" &&
    value.params.arguments !== null &&
    "type" in value.params.arguments &&
    typeof value.params.arguments.type === "string"
  );
}
