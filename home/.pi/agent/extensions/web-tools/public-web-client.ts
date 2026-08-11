import type { Redacted } from "./redacted.ts";
import type { Result } from "./result.ts";
import type { PublicHttpUrl } from "./types.ts";

export interface PublicWebRequest {
  readonly accept: string;
  readonly blockPrivateHosts: boolean;
  readonly fallbackUserAgent: string;
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
  readonly url: PublicHttpUrl;
  readonly userAgent: string;
}

export interface PublicWebResponse {
  readonly body: Buffer;
  readonly bytes: number;
  readonly finalUrl: PublicHttpUrl;
  readonly headers: Headers;
  readonly requestedUrl: PublicHttpUrl;
  readonly status: number;
  readonly statusText: string;
}

export type PublicWebError =
  | { readonly _tag: "PublicWebRequestFailed"; readonly cause: unknown }
  | { readonly _tag: "PublicWebCancelled"; readonly cause?: unknown }
  | { readonly _tag: "PublicWebTimedOut"; readonly timeoutSeconds: number }
  | { readonly _tag: "UrlCredentialsUnsupported"; readonly url: Redacted<string> }
  | { readonly _tag: "PrivateHostBlocked"; readonly url: PublicHttpUrl }
  | { readonly _tag: "PrivateIpBlocked"; readonly url: PublicHttpUrl }
  | { readonly _tag: "RedirectLocationMissing"; readonly url: PublicHttpUrl }
  | { readonly _tag: "RedirectLocationInvalid" }
  | { readonly _tag: "RedirectLimitExceeded"; readonly url: PublicHttpUrl; readonly maxRedirects: number }
  | { readonly _tag: "RedirectProtocolUnsupported"; readonly protocol: string }
  | { readonly _tag: "HttpStatusRejected"; readonly status: number; readonly statusText: string }
  | { readonly _tag: "ResponseTooLarge"; readonly maxBytes: number };

export interface PublicWebClient {
  get(
    request: PublicWebRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<Result<PublicWebResponse, PublicWebError>>;
}
