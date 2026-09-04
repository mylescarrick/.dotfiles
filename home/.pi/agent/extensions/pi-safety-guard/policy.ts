import { basename, resolve } from "node:path";

export interface EnvKeyStatus {
  key: string;
  present: boolean;
}

export interface BashRisk {
  label: string;
}

const ENV_FILE_NAME = /^\.env(?:\..+)?$/;
const SECRET_PATH =
  /(?:^|\/)(?:\.ssh(?:\/|$)|\.aws\/(?:credentials|config)$|\.kube\/config$|\.git-credentials$|auth\.json$|\.npmrc$|\.netrc$|\.pypirc$|id_(?:rsa|ed25519)(?:\.pub)?$)|\.(?:pem|key|p12|kdbx)$/i;
const BASH_RISKS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "recursive file removal", pattern: /(?:^|[^\w-])rm\s+[^\n;&|]*-[^\s;&|]*r/i },
  { label: "forced file removal", pattern: /(?:^|[^\w-])rm\s+[^\n;&|]*-[^\s;&|]*f/i },
  { label: "Git history reset", pattern: /\bgit\s+reset\b/i },
  { label: "Git clean", pattern: /\bgit\s+clean\b[^\n;&|]*-[^\s;&|]*f/i },
  { label: "force Git push", pattern: /\bgit\s+push\b[^\n;&|]*--force(?:-with-lease)?\b/i },
  {
    label: "container cleanup",
    pattern: /\b(?:docker|podman)\s+(?:system\s+prune|volume\s+(?:rm|prune)|rmi?\b)/i,
  },
  { label: "disk write", pattern: /\bdd\b/i },
  { label: "filesystem formatting", pattern: /\b(?:mkfs|wipefs|fdisk|parted)\b/i },
  {
    label: "secret file access",
    pattern:
      /\b(?:cat|grep|rg|awk|sed|head|tail|less|more|cp)\b[^\n;&|]*(?:\.env(?:\.[^\s;&|]+)?|\.ssh|\.aws\/(?:credentials|config)|\.kube\/config|\.git-credentials|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|ed25519)|\.(?:pem|key|p12|kdbx))/i,
  },
];

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

export function classifyBashCommand(command: string): BashRisk | undefined {
  return BASH_RISKS.find((risk) => risk.pattern.test(command));
}
