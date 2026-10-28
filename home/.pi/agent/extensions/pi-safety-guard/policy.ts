import { basename, resolve } from "node:path";

export interface EnvKeyStatus {
  key: string;
  present: boolean;
}

const ENV_FILE_NAME = /^\.env(?:\..+)?$/;
const SECRET_PATH =
  /(?:^|\/)(?:\.ssh(?:\/|$)|\.aws\/(?:credentials|config)$|\.kube\/config$|\.git-credentials$|auth\.json$|\.npmrc$|\.netrc$|\.pypirc$|id_(?:rsa|ed25519)(?:\.pub)?$)|\.(?:pem|key|p12|kdbx)$/i;
function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "~", path.slice(2));
  return path;
}

function normalizedPath(path: string, cwd: string): string {
  return resolve(cwd, expandHome(path.replace(/^@/, ""))).replaceAll("\\", "/");
}

export function resolveSafeEnvPath(path: string, cwd: string): string | undefined {
  const resolved = normalizedPath(path, cwd);
  return ENV_FILE_NAME.test(basename(resolved)) ? resolved : undefined;
}

export function isProtectedPath(path: string, cwd: string): boolean {
  const resolved = normalizedPath(path, cwd);
  return ENV_FILE_NAME.test(basename(resolved)) || SECRET_PATH.test(resolved);
}

export function checkEnvKeys(text: string, keys: readonly string[]): EnvKeyStatus[] {
  const available = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match?.[1]) available.add(match[1]);
  }
  return keys.map((key) => ({ key, present: available.has(key) }));
}
