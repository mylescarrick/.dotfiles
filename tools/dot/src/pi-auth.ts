import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replacePrivateFile } from "./pi";
import type { Terminal } from "./terminal";

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = text.trim() ? JSON.parse(text) : {};
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Pi auth must contain a JSON object");
  }
  return value as Record<string, unknown>;
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
    parseObject(await readFile(path, "utf8"));
  } catch (error) {
    issues.push(error instanceof SyntaxError ? "Pi auth contains invalid JSON" : (error as Error).message);
  }
  return issues;
}

function quoteResolver(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function configureCloudflareAuth(options: {
  readonly accountId?: string;
  readonly apiKeyEnv?: string;
  readonly apiKeyOpRef?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly gatewayId?: string;
  readonly home: string;
  readonly terminal: Terminal;
}): Promise<string> {
  let accountId = options.accountId ?? options.env.DOT_CLOUDFLARE_ACCOUNT_ID;
  let gatewayId = options.gatewayId ?? options.env.DOT_CLOUDFLARE_GATEWAY_ID;
  if (!accountId && options.terminal.interactive) {
    accountId = await options.terminal.prompt("Cloudflare account ID: ");
  }
  if (!gatewayId && options.terminal.interactive) {
    gatewayId = await options.terminal.prompt("Cloudflare AI Gateway ID/slug: ");
  }
  if (!accountId || !gatewayId) {
    throw new Error("Cloudflare account and gateway IDs are required");
  }

  const key = options.apiKeyOpRef
    ? `!op read ${quoteResolver(options.apiKeyOpRef)}`
    : `$${options.apiKeyEnv || "CLOUDFLARE_API_KEY"}`;
  const authPath = join(options.home, ".pi/agent/auth.json");
  let auth: Record<string, unknown> = {};
  try {
    auth = parseObject(await readFile(authPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error("Pi auth contains invalid JSON");
      throw error;
    }
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
    auth[provider] = { type: "api_key", key, env: { ...existingEnv, ...patch } };
  };

  upsert("cloudflare-ai-gateway", {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_GATEWAY_ID: gatewayId,
  });
  upsert("cloudflare-workers-ai", { CLOUDFLARE_ACCOUNT_ID: accountId });
  await replacePrivateFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  return "Pi Cloudflare auth configured\n";
}
