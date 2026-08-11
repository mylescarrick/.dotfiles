import assert from "node:assert/strict";
import test from "node:test";
import { parseExaMcpResponse, parseSseDataLines } from "../providers/exa-protocol.ts";

const PROVIDER_TEXT = [
  "Title: Example Domain",
  "URL: https://example.com/",
  "Text: Example Domain",
  "",
  "Documentation-safe example domain.",
].join("\n");

const SSE_RESPONSE = `event: message\ndata: ${JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  result: {
    content: [{ text: PROVIDER_TEXT, type: "text" }],
  },
})}\n\n`;

const SSE_ERROR_RESPONSE = `event: message\ndata: ${JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  result: {
    content: [{ text: "MCP error -32602: Invalid enum value", type: "text" }],
    isError: true,
  },
})}\n\n`;

test("parseSseDataLines extracts JSON payloads from event streams", () => {
  const chunks = parseSseDataLines(SSE_RESPONSE);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0] ?? "", /"jsonrpc":"2.0"/);
});

test("parseExaMcpResponse extracts text messages from SSE", () => {
  const result = parseExaMcpResponse(SSE_RESPONSE, "text/event-stream");

  assert.equal(result._tag, "ok");
  assert.equal(result.value[0]?._tag, "Text");
  assert.match(result.value[0]?._tag === "Text" ? result.value[0].text : "", /^Title: Example Domain/m);
});

test("parseExaMcpResponse extracts provider error messages safely", () => {
  const result = parseExaMcpResponse(SSE_ERROR_RESPONSE, "text/event-stream");

  assert.deepEqual(result, {
    _tag: "ok",
    value: [{ _tag: "ProviderError", safeMessage: "Search provider returned an error" }],
  });
});

test("parseExaMcpResponse parses JSON MCP responses", () => {
  const result = parseExaMcpResponse(
    JSON.stringify({ result: { content: [{ text: PROVIDER_TEXT, type: "text" }] } }),
    "application/json"
  );

  assert.equal(result._tag, "ok");
  assert.equal(result.value[0]?._tag, "Text");
});

test("parseExaMcpResponse rejects malformed payloads without trust casts", () => {
  assert.deepEqual(parseExaMcpResponse("{", "application/json"), {
    _tag: "err",
    error: { _tag: "InvalidJson", source: "json" },
  });
  assert.deepEqual(parseExaMcpResponse(JSON.stringify({ result: {} }), "application/json"), {
    _tag: "err",
    error: { _tag: "InvalidMcpPayload", reason: "Missing result.content array" },
  });
  assert.deepEqual(parseExaMcpResponse("event: message\ndata: {\n\n", "text/event-stream"), {
    _tag: "err",
    error: { _tag: "InvalidJson", source: "sse" },
  });
});
