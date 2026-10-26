import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";

export interface DeployRecord {
  /** Home-relative path to the hash `dot` last wrote there. */
  entries: Record<string, { hash: string }>;
  /** Drift fingerprints already sent to a PR or snoozed, with when that happened. */
  handled: Record<string, string>;
}

export function stateDirectory(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(env.XDG_STATE_HOME || join(home, ".local/state"), "dot");
}

export function cacheDirectory(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "dot");
}

function recordPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(stateDirectory(env, home), "deployed.json");
}

export async function readDeployRecord(
  env: Readonly<Record<string, string | undefined>>,
  home: string
): Promise<DeployRecord> {
  try {
    const parsed = JSON.parse(await readFile(recordPath(env, home), "utf8")) as Partial<DeployRecord> & {
      version?: number;
    };
    if (parsed.version !== 1) throw new Error(`unsupported deploy record version: ${parsed.version}`);
    return { entries: parsed.entries ?? {}, handled: parsed.handled ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: {}, handled: {} };
    throw error;
  }
}

export async function writeDeployRecord(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  record: DeployRecord
): Promise<void> {
  const path = recordPath(env, home);
  await mkdir(dirname(path), { recursive: true });
  const payload = { entries: record.entries, handled: record.handled, version: 1 };
  await replaceFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
}
