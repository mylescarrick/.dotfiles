import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  PublicWebClient,
  PublicWebError,
  PublicWebRequest,
  PublicWebResponse,
} from "./public-web-client.ts";
import { err, ok, type Result } from "./result.ts";
import {
  type ContentKind,
  type ParsedContentType,
  type ParsePublicHttpUrlError,
  type PublicHttpUrl,
  parsePublicHttpUrl,
} from "./types.ts";

const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "image/svg+xml",
]);
const RASTER_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface FetchWithRedirectsOptions {
  blockPrivateHosts: boolean;
  headers: Record<string, string>;
  maxRedirects: number;
  signal?: AbortSignal;
}

export interface FetchWithRedirectsResult {
  finalUrl: URL;
  response: Response;
}

export interface ReadBodyResult {
  buffer: Buffer;
  bytes: number;
}

export interface ComposedSignal {
  cleanup: () => void;
  signal: AbortSignal;
}

export class OperationTimeoutError extends Error {
  readonly _tag = "OperationTimeout" as const;

  constructor(readonly timeoutSeconds: number) {
    super(`Operation timed out after ${timeoutSeconds}s`);
    this.name = "OperationTimeoutError";
  }
}

export function createOperationSignal(timeoutMs: number, outerSignal?: AbortSignal): ComposedSignal {
  const controller = new AbortController();
  const timeoutSeconds = Math.ceil(timeoutMs / 1000);
  const timeoutId = setTimeout(() => {
    controller.abort(new OperationTimeoutError(timeoutSeconds));
  }, timeoutMs);
  const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  return {
    cleanup: () => clearTimeout(timeoutId),
    signal,
  };
}

export function isOperationTimeoutError(value: unknown): value is OperationTimeoutError {
  return (
    value instanceof OperationTimeoutError ||
    (typeof value === "object" && value !== null && "_tag" in value && value._tag === "OperationTimeout")
  );
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function normalizeAndValidateUrl(rawUrl: string): URL {
  const parsed = parsePublicHttpUrl(rawUrl);
  if (parsed._tag === "err") {
    throw new Error(renderSafeUrlParseError(parsed.error));
  }
  return new URL(parsed.value);
}

export async function fetchWithRedirects(
  initialUrl: URL,
  options: FetchWithRedirectsOptions
): Promise<FetchWithRedirectsResult> {
  let currentUrl = initialUrl;
  let redirects = 0;

  for (;;) {
    assertUrlHasNoCredentials(currentUrl);
    if (options.blockPrivateHosts) {
      await assertPublicUrl(currentUrl);
    }

    const response = await fetch(currentUrl, {
      headers: options.headers,
      method: "GET",
      redirect: "manual",
      signal: options.signal,
    });

    if (isRedirectStatus(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirect response was missing a Location header");
      }
      if (redirects >= options.maxRedirects) {
        throw new Error("Too many redirects while fetching URL");
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch (error) {
        throw new Error("Redirect response had an invalid Location header", { cause: error });
      }
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        throw new Error("Redirected to unsupported protocol");
      }
      assertUrlHasNoCredentials(nextUrl);
      currentUrl = nextUrl;
      redirects += 1;
      continue;
    }

    return { finalUrl: currentUrl, response };
  }
}

export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ReadBodyResult> {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), bytes: 0 };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;

  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel(signal.reason).catch(() => undefined);
        throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response too large (exceeds ${Math.floor(maxBytes / (1024 * 1024))}MB limit)`);
      }

      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }

  return {
    buffer: Buffer.concat(chunks),
    bytes,
  };
}

export function parseContentType(contentTypeHeader: string | null | undefined): ParsedContentType {
  const contentType = contentTypeHeader?.trim() ?? "";
  const [mimePart = ""] = contentType.split(";");
  const mime = mimePart.trim().toLowerCase();
  const charsetMatch = contentType.match(/charset\s*=\s*['"]?([^;'"]+)/i);
  const charset = charsetMatch?.[1]?.trim().toLowerCase();
  return {
    charset,
    contentType,
    kind: classifyMimeType(mime),
    mime,
  };
}

export function classifyMimeType(mime: string): ContentKind {
  const normalized = mime.trim().toLowerCase();
  if (!normalized) return "binary";
  if (HTML_MIME_TYPES.has(normalized)) return "html";
  if (RASTER_IMAGE_MIME_TYPES.has(normalized)) return "raster-image";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized.startsWith("text/")) return normalized === "text/html" ? "html" : "text";
  if (TEXT_MIME_TYPES.has(normalized) || normalized.endsWith("+xml") || normalized.endsWith("+json"))
    return "text";
  return "binary";
}

export function decodeTextBuffer(buffer: Buffer, charset?: string): { text: string; decoder: string } {
  const normalizedCharset = normalizeCharset(charset);
  if (normalizedCharset) {
    try {
      return {
        decoder: normalizedCharset,
        text: new TextDecoder(normalizedCharset).decode(buffer),
      };
    } catch {
      // Fall back to utf-8 below.
    }
  }
  return {
    decoder: "utf-8",
    text: new TextDecoder("utf-8").decode(buffer),
  };
}

export function normalizeCharset(charset: string | undefined): string | undefined {
  if (!charset) return undefined;
  const normalized = charset.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "utf8") return "utf-8";
  return normalized;
}

async function assertPublicUrl(url: URL): Promise<void> {
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new Error("Blocked private or local host");
  }
  if (isPrivateOrLocalIp(hostname)) {
    throw new Error("Blocked private or local IP address");
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    for (const record of records) {
      if (isPrivateOrLocalIp(record.address)) {
        throw new Error("Blocked private or local IP address");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Blocked private or local IP address") {
      throw error;
    }
    // If DNS resolution fails, let the later fetch surface the real connectivity error.
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function assertUrlHasNoCredentials(url: URL): void {
  if (url.username || url.password) {
    throw new Error("URL credentials are not supported");
  }
}

function renderSafeUrlParseError(error: ParsePublicHttpUrlError): string {
  switch (error._tag) {
    case "EmptyUrl":
      return "URL cannot be empty";
    case "UnsupportedUrlProtocol":
      return "URL must start with http:// or https://";
    case "InvalidUrl":
      return "Invalid URL";
    case "UrlCredentialsUnsupported":
      return "URL credentials are not supported";
  }
}

/** RFC1918 private ranges, loopback, link-local, and CGNAT. */
function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/** Loopback/unspecified, unique-local (fc00::/7), and link-local (fe80::/10). */
function isPrivateIpv6(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return /^fe[89ab]/.test(ip);
}

export function isPrivateOrLocalIp(input: string): boolean {
  const ip = normalizeIpLiteral(input);
  if (!ip) return false;

  const mappedIpv4 = parseIpv4MappedIpv6Address(ip);
  if (mappedIpv4) return isPrivateOrLocalIp(mappedIpv4);

  const compatibleIpv4 = parseIpv4CompatibleIpv6Address(ip);
  if (compatibleIpv4) return isPrivateOrLocalIp(compatibleIpv4);

  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function normalizeIpLiteral(input: string): string {
  const ip = stripIpv6Brackets(input).toLowerCase();
  if (isIP(ip) !== 6) {
    return ip;
  }

  try {
    return stripIpv6Brackets(new URL(`http://[${ip}]/`).hostname).toLowerCase();
  } catch {
    return ip;
  }
}

function parseIpv4MappedIpv6Address(ip: string): string | undefined {
  const prefix = "::ffff:";
  if (!ip.startsWith(prefix)) {
    return undefined;
  }

  const suffix = ip.slice(prefix.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }

  const segments = suffix.split(":");
  if (segments.length !== 2) {
    return undefined;
  }

  const high = parseIpv6Hex16(segments[0]);
  const low = parseIpv6Hex16(segments[1]);
  if (high === undefined || low === undefined) {
    return undefined;
  }

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function parseIpv4CompatibleIpv6Address(ip: string): string | undefined {
  const prefix = "::";
  if (!ip.startsWith(prefix)) {
    return undefined;
  }

  const suffix = ip.slice(prefix.length);
  const segments = suffix.split(":");
  if (segments.length !== 2) {
    return undefined;
  }

  const high = parseIpv6Hex16(segments[0]);
  const low = parseIpv6Hex16(segments[1]);
  if (high === undefined || low === undefined) {
    return undefined;
  }

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function parseIpv6Hex16(segment: string | undefined): number | undefined {
  if (!(segment && /^[0-9a-f]{1,4}$/i.test(segment))) {
    return undefined;
  }

  const value = Number.parseInt(segment, 16);
  return Number.isFinite(value) && value >= 0 && value <= 0xffff ? value : undefined;
}

export class FetchPublicWebClient implements PublicWebClient {
  /** Fetch a bounded public web response, following safe redirects. */
  async get(
    request: PublicWebRequest,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Result<PublicWebResponse, PublicWebError>> {
    const firstFetch = await fetchWithUserAgent(request, request.userAgent, options.signal);
    if (firstFetch._tag === "err") {
      return firstFetch;
    }

    let response = firstFetch.value.response;
    let finalUrl = firstFetch.value.finalUrl;
    if (isCloudflareChallenge(response)) {
      await response.body?.cancel().catch(() => undefined);
      const retryFetch = await fetchWithUserAgent(request, request.fallbackUserAgent, options.signal);
      if (retryFetch._tag === "err") {
        return retryFetch;
      }
      response = retryFetch.value.response;
      finalUrl = retryFetch.value.finalUrl;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return err({ _tag: "HttpStatusRejected", status: response.status, statusText: response.statusText });
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const declaredBytes = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > request.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        return err({ _tag: "ResponseTooLarge", maxBytes: request.maxResponseBytes });
      }
    }

    try {
      const body = await readBodyWithLimit(response, request.maxResponseBytes, options.signal);
      return ok({
        body: body.buffer,
        bytes: body.bytes,
        finalUrl,
        headers: response.headers,
        requestedUrl: request.url,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (cause: unknown) {
      if (options.signal?.aborted) {
        return err(classifySignalAbort(options.signal, cause));
      }
      if (isResponseTooLargeCause(cause)) {
        return err({ _tag: "ResponseTooLarge", maxBytes: request.maxResponseBytes });
      }
      return err({ _tag: "PublicWebRequestFailed", cause });
    }
  }
}

async function performRequest(
  request: PublicWebRequest,
  currentUrl: URL,
  userAgent: string,
  signal?: AbortSignal
): Promise<Result<Response, PublicWebError>> {
  try {
    return ok(
      await fetch(currentUrl, {
        headers: createPublicWebHeaders(request.accept, userAgent),
        method: "GET",
        redirect: "manual",
        signal,
      })
    );
  } catch (cause: unknown) {
    if (signal?.aborted || isAbortError(cause)) {
      return err(signal ? classifySignalAbort(signal, cause) : { _tag: "PublicWebCancelled", cause });
    }
    return err({ _tag: "PublicWebRequestFailed", cause });
  }
}

/** Validates a redirect response and resolves the next URL to fetch. */
function resolveRedirectTarget(
  request: PublicWebRequest,
  response: Response,
  currentUrl: URL,
  currentPublicUrl: PublicHttpUrl,
  redirects: number
): Result<URL, PublicWebError> {
  const location = response.headers.get("location");
  if (!location) return err({ _tag: "RedirectLocationMissing", url: currentPublicUrl });
  if (redirects >= request.maxRedirects) {
    return err({ _tag: "RedirectLimitExceeded", maxRedirects: request.maxRedirects, url: request.url });
  }

  let nextUrl: URL;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch {
    return err({ _tag: "RedirectLocationInvalid" });
  }
  if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
    return err({ _tag: "RedirectProtocolUnsupported", protocol: nextUrl.protocol });
  }
  return ok(nextUrl);
}

async function fetchWithUserAgent(
  request: PublicWebRequest,
  userAgent: string,
  signal?: AbortSignal
): Promise<Result<{ readonly response: Response; readonly finalUrl: PublicHttpUrl }, PublicWebError>> {
  let currentUrl = new URL(request.url);
  let redirects = 0;

  for (;;) {
    if (signal?.aborted) return err(classifySignalAbort(signal));

    const currentPublicUrl = publicHttpUrlFromUrl(currentUrl);
    if (currentPublicUrl._tag === "err") return currentPublicUrl;

    if (request.blockPrivateHosts) {
      const publicCheck = await checkPublicUrl(currentUrl, currentPublicUrl.value);
      if (publicCheck._tag === "err") return publicCheck;
    }

    const attempt = await performRequest(request, currentUrl, userAgent, signal);
    if (attempt._tag === "err") return attempt;
    const response = attempt.value;

    if (!isRedirectStatus(response.status)) {
      return ok({ finalUrl: currentPublicUrl.value, response });
    }

    await response.body?.cancel().catch(() => undefined);
    const next = resolveRedirectTarget(request, response, currentUrl, currentPublicUrl.value, redirects);
    if (next._tag === "err") return next;

    currentUrl = next.value;
    redirects += 1;
  }
}

function createPublicWebHeaders(accept: string, userAgent: string): Record<string, string> {
  return {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": userAgent,
  };
}

async function checkPublicUrl(url: URL, publicUrl: PublicHttpUrl): Promise<Result<void, PublicWebError>> {
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (isBlockedHostname(hostname)) {
    return err({ _tag: "PrivateHostBlocked", url: publicUrl });
  }
  if (isPrivateOrLocalIp(hostname)) {
    return err({ _tag: "PrivateIpBlocked", url: publicUrl });
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    for (const record of records) {
      if (isPrivateOrLocalIp(record.address)) {
        return err({ _tag: "PrivateIpBlocked", url: publicUrl });
      }
    }
  } catch {
    // If DNS resolution fails, let fetch surface the connectivity failure.
  }

  return ok(undefined);
}

function publicHttpUrlFromUrl(url: URL): Result<PublicHttpUrl, PublicWebError> {
  const parsed = parsePublicHttpUrl(url.toString());
  if (parsed._tag === "err") {
    return err(mapPublicHttpUrlParseError(parsed.error));
  }
  return parsed;
}

function mapPublicHttpUrlParseError(error: ParsePublicHttpUrlError): PublicWebError {
  switch (error._tag) {
    case "UrlCredentialsUnsupported":
      return { _tag: "UrlCredentialsUnsupported", url: error.url };
    case "UnsupportedUrlProtocol":
      return { _tag: "RedirectProtocolUnsupported", protocol: error.protocol ?? "unknown" };
    case "EmptyUrl":
    case "InvalidUrl":
      return { _tag: "PublicWebRequestFailed", cause: error };
  }
}

function classifySignalAbort(signal: AbortSignal, cause?: unknown): PublicWebError {
  if (isOperationTimeoutError(signal.reason)) {
    return { _tag: "PublicWebTimedOut", timeoutSeconds: signal.reason.timeoutSeconds };
  }
  return { _tag: "PublicWebCancelled", cause };
}

function isCloudflareChallenge(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 403 && response.headers.get("cf-mitigated") === "challenge";
}

function isResponseTooLargeCause(cause: unknown): boolean {
  return cause instanceof Error && cause.message.startsWith("Response too large");
}
