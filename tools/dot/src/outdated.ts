import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import { listInstalledGlobal, readManifest } from "./bun-global";
import { stateDirectory } from "./deploy-record";
import { parseJsonObject } from "./json";
import { parseNpmPackageName } from "./pi-packages";
import type { ProcessRunner } from "./process";

export interface OutdatedItem {
  readonly installed: string;
  readonly latest: string;
  readonly name: string;
}

export interface OutdatedReport {
  readonly brew: readonly OutdatedItem[];
  readonly bun: readonly OutdatedItem[];
  readonly checkedAt: string;
  /** One line per source that could not be checked; its entries above are kept from the previous check. */
  readonly errors: readonly string[];
  readonly pi: readonly OutdatedItem[];
}

type Env = Readonly<Record<string, string | undefined>>;

interface CollectOptions {
  readonly checkoutRoot: string;
  readonly env: Env;
  readonly home: string;
  /** Latest published version of an npm package, or undefined when the registry can't say. */
  readonly latestVersion?: (name: string) => Promise<string | undefined>;
  readonly now?: Date;
  readonly previous?: OutdatedReport;
  readonly processes: ProcessRunner;
}

export async function registryLatest(name: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    return ((await response.json()) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function isNewer(latest: string, installed: string): boolean {
  return Bun.semver.order(latest, installed) === 1;
}

interface BrewOutdatedJson {
  readonly casks?: readonly BrewEntry[];
  readonly formulae?: readonly BrewEntry[];
}
interface BrewEntry {
  readonly current_version: string;
  readonly installed_versions: string | readonly string[];
  readonly name: string;
}

export function parseBrewOutdated(stdout: string): OutdatedItem[] {
  const parsed = JSON.parse(stdout) as BrewOutdatedJson;
  return [...(parsed.formulae ?? []), ...(parsed.casks ?? [])].map((entry) => ({
    installed: [entry.installed_versions].flat().join(", "),
    latest: entry.current_version,
    name: entry.name,
  }));
}

async function checkBrew(options: CollectOptions): Promise<OutdatedItem[]> {
  const env = { ...options.env, HOMEBREW_NO_AUTO_UPDATE: "1" };
  // Without this, brew compares against whatever index it last fetched, which is how it reports nothing for weeks.
  const update = await options.processes.run({
    argv: ["brew", "update", "--quiet"],
    cwd: options.checkoutRoot,
    env,
  });
  if (update.exitCode !== 0) throw new Error(`brew update failed: ${update.stderr.trim()}`);
  const result = await options.processes.run({
    argv: ["brew", "outdated", "--json=v2"],
    cwd: options.checkoutRoot,
    env,
  });
  if (result.exitCode !== 0) throw new Error(`brew outdated failed: ${result.stderr.trim()}`);
  return parseBrewOutdated(result.stdout);
}

async function newerOnly(
  candidates: ReadonlyMap<string, string>,
  latestVersion: (name: string) => Promise<string | undefined>
): Promise<OutdatedItem[]> {
  const found = await Promise.all(
    [...candidates].map(async ([name, installed]) => {
      const latest = await latestVersion(name);
      return latest && isNewer(latest, installed) ? { installed, latest, name } : undefined;
    })
  );
  return found.filter((item): item is OutdatedItem => item !== undefined);
}

async function checkBun(
  options: CollectOptions,
  latestVersion: NonNullable<CollectOptions["latestVersion"]>
) {
  const pinned = new Set(
    (await readManifest(options.checkoutRoot)).filter((pkg) => pkg.version).map((pkg) => pkg.name)
  );
  const installed = await listInstalledGlobal(options);
  return newerOnly(new Map([...installed].filter(([name]) => !pinned.has(name))), latestVersion);
}

async function checkPi(options: CollectOptions, latestVersion: NonNullable<CollectOptions["latestVersion"]>) {
  const settings = parseJsonObject(
    await readFile(join(options.checkoutRoot, "config/pi/settings.defaults.json"), "utf8"),
    "Tracked Pi settings defaults"
  );
  const sources = Array.isArray(settings.packages) ? (settings.packages as unknown[]) : [];
  const installed = new Map<string, string>();
  for (const source of sources) {
    if (typeof source !== "string") continue;
    const name = parseNpmPackageName(source);
    // A source with a version suffix is pinned on purpose.
    if (!name || source !== `npm:${name}`) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(options.home, ".pi/agent/npm/node_modules", name, "package.json"), "utf8")
      ) as { version?: string };
      if (manifest.version) installed.set(name, manifest.version);
    } catch {
      // Not installed yet: apply installs it, so it is not "outdated".
    }
  }
  return newerOnly(installed, latestVersion);
}

/** Checks every source independently; one failing (offline, brew locked) keeps its previous result. */
export async function collectOutdated(options: CollectOptions): Promise<OutdatedReport> {
  const latestVersion = options.latestVersion ?? registryLatest;
  const previous = options.previous;
  const errors: string[] = [];
  async function attempt(source: "brew" | "bun" | "pi", check: () => Promise<OutdatedItem[]>) {
    try {
      return await check();
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      return previous?.[source] ?? [];
    }
  }
  const [brew, bun, pi] = await Promise.all([
    attempt("brew", () => checkBrew(options)),
    attempt("bun", () => checkBun(options, latestVersion)),
    attempt("pi", () => checkPi(options, latestVersion)),
  ]);
  return { brew, bun, checkedAt: (options.now ?? new Date()).toISOString(), errors, pi };
}

function reportPath(env: Env, home: string): string {
  return join(stateDirectory(env, home), "outdated.json");
}

export async function readOutdated(env: Env, home: string): Promise<OutdatedReport | undefined> {
  try {
    const parsed = JSON.parse(await readFile(reportPath(env, home), "utf8")) as Partial<OutdatedReport>;
    return {
      brew: parsed.brew ?? [],
      bun: parsed.bun ?? [],
      checkedAt: parsed.checkedAt ?? "",
      errors: parsed.errors ?? [],
      pi: parsed.pi ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeOutdated(env: Env, home: string, report: OutdatedReport): Promise<void> {
  const path = reportPath(env, home);
  await mkdir(dirname(path), { recursive: true });
  await replaceFileAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
}

const SOURCE_LABELS = { brew: "Homebrew", bun: "Bun", pi: "Pi packages" } as const;

export function outdatedCount(report: OutdatedReport): number {
  return report.brew.length + report.bun.length + report.pi.length;
}

function age(checkedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(checkedAt)) / 60_000));
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** What the user sees: names and versions per source, and how fresh the check is. */
export function describeOutdated(report: OutdatedReport | undefined, now = new Date()): string {
  if (!report) return "No outdated check yet. Run 'dot outdated --refresh'.\n";
  const sections = (["brew", "bun", "pi"] as const)
    .filter((source) => report[source].length > 0)
    .map(
      (source) =>
        `  ${SOURCE_LABELS[source]}:\n${report[source].map((item) => `    ${item.name}  ${item.installed} -> ${item.latest}`).join("\n")}`
    );
  const when = `checked ${age(report.checkedAt, now)}`;
  const problems = report.errors.map((line) => `  could not check ${line}`).join("\n");
  const head = sections.length
    ? `${outdatedCount(report)} update(s) available (${when}):\n${sections.join("\n")}`
    : `Everything is up to date (${when}).`;
  return `${head}\n${problems ? `${problems}\n` : ""}`;
}
