import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJsonObject } from "./json";
import { replacePrivateFile } from "./pi";
import type { Terminal } from "./terminal";

export type CloudflareKeySource =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "op"; readonly reference: string };

export interface CloudflareAuthInput {
  readonly accountId?: string;
  readonly gatewayId?: string;
  readonly keySource?: CloudflareKeySource;
}

export type CloudflareArgsResult =
  | { readonly ok: true; readonly input: CloudflareAuthInput }
  | { readonly ok: false; readonly message: string };

export function parseCloudflareAuthArgs(args: readonly string[]): CloudflareArgsResult {
  let accountId: string | undefined;
  let gatewayId: string | undefined;
  let keySource: CloudflareKeySource | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      return { message: "dot: usage: dot pi auth cloudflare [OPTIONS]\n", ok: false };
    }
    if (flag === "--account-id" && accountId === undefined) accountId = value;
    else if (flag === "--gateway-id" && gatewayId === undefined) gatewayId = value;
    else if (flag === "--api-key-env" && keySource === undefined) {
      keySource = { kind: "env", name: value };
    } else if (flag === "--api-key-op-ref" && keySource === undefined) {
      keySource = { kind: "op", reference: value };
    } else if ((flag === "--api-key-env" || flag === "--api-key-op-ref") && keySource !== undefined) {
      return { message: "dot: choose one Cloudflare API key source\n", ok: false };
    } else {
      return { message: "dot: usage: dot pi auth cloudflare [OPTIONS]\n", ok: false };
    }
  }
  return { input: { accountId, gatewayId, keySource }, ok: true };
}

export type ExaKeySource =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "op"; readonly reference: string };

export interface ExaAuthInput {
  readonly keySource?: ExaKeySource;
}

export type ExaArgsResult =
  | { readonly ok: true; readonly input: ExaAuthInput }
  | { readonly ok: false; readonly message: string };

export function parseExaAuthArgs(args: readonly string[]): ExaArgsResult {
  let keySource: ExaKeySource | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      return { message: "dot: usage: dot pi auth exa [OPTIONS]\n", ok: false };
    }
    if (flag === "--api-key-env" && keySource === undefined) {
      keySource = { kind: "env", name: value };
    } else if (flag === "--api-key-op-ref" && keySource === undefined) {
      keySource = { kind: "op", reference: value };
    } else if ((flag === "--api-key-env" || flag === "--api-key-op-ref") && keySource !== undefined) {
      return { message: "dot: choose one Exa API key source\n", ok: false };
    } else {
      return { message: "dot: usage: dot pi auth exa [OPTIONS]\n", ok: false };
    }
  }
  return { input: { keySource }, ok: true };
}

export async function inspectPiAuth(home: string): Promise<string[]> {
  const path = join(home, ".pi/agent/auth.json");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!metadata.isFile()) return ["Pi auth is not a private regular file"];

  const issues: string[] = [];
  if ((metadata.mode & 0o777) !== 0o600) issues.push("Pi auth mode is not 0600");
  try {
    parseJsonObject(await readFile(path, "utf8"), "Pi auth");
  } catch (error) {
    issues.push((error as Error).message);
  }
  return issues;
}

function quoteResolver(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function configureCloudflareAuth(
  options: CloudflareAuthInput & {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly home: string;
    readonly terminal: Terminal;
  }
): Promise<string> {
  let accountId = options.accountId ?? options.env.DOT_CLOUDFLARE_ACCOUNT_ID;
  let gatewayId = options.gatewayId ?? options.env.DOT_CLOUDFLARE_GATEWAY_ID;
  if (!accountId && options.terminal.interactive) {
    accountId = await options.terminal.prompt("Cloudflare account ID: ");
  }
  if (!gatewayId && options.terminal.interactive) {
    gatewayId = await options.terminal.prompt("Cloudflare AI Gateway ID/slug: ");
  }
  if (!(accountId && gatewayId)) {
    throw new Error("Cloudflare account and gateway IDs are required");
  }

  const keySource = options.keySource ?? {
    kind: "env" as const,
    name: "CLOUDFLARE_API_KEY",
  };
  const key =
    keySource.kind === "op" ? `!op read ${quoteResolver(keySource.reference)}` : `$${keySource.name}`;
  const authPath = join(options.home, ".pi/agent/auth.json");
  let auth: Record<string, unknown> = {};
  try {
    auth = parseJsonObject(await readFile(authPath, "utf8"), "Pi auth");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const upsert = (provider: string, patch: Record<string, string>) => {
    const existing = auth[provider];
    const existingEnv =
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      (existing as { type?: unknown }).type === "api_key" &&
      (existing as { env?: unknown }).env &&
      typeof (existing as { env: unknown }).env === "object"
        ? ((existing as { env: Record<string, unknown> }).env ?? {})
        : {};
    auth[provider] = { env: { ...existingEnv, ...patch }, key, type: "api_key" };
  };

  upsert("cloudflare-ai-gateway", {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_GATEWAY_ID: gatewayId,
  });
  upsert("cloudflare-workers-ai", { CLOUDFLARE_ACCOUNT_ID: accountId });
  await replacePrivateFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  return "Pi Cloudflare auth configured\n";
}

export async function configureExaAuth(
  options: ExaAuthInput & {
    readonly home: string;
  }
): Promise<string> {
  const keySource = options.keySource ?? { kind: "env" as const, name: "EXA_API_KEY" };
  const key =
    keySource.kind === "op" ? `!op read ${quoteResolver(keySource.reference)}` : `$${keySource.name}`;

  const authPath = join(options.home, ".pi/agent/web-tools-auth.json");
  let auth: Record<string, unknown> = {};
  try {
    auth = parseJsonObject(await readFile(authPath, "utf8"), "web-tools auth");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  auth.exa = { key, type: "api_key" };
  await replacePrivateFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  return "Exa search auth configured\n";
}
