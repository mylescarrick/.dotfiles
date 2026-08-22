import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { inspectGlobalBunPackages } from "./bun-global";
import { guardCanonicalCheckout } from "./checkout";
import { inspectPackages } from "./packages";
import { inspectPiSettings, planPiSettings } from "./pi";
import { inspectPiAuth } from "./pi-auth";
import type { ProcessRunner } from "./process";
import { validateSkillLinks } from "./skills";
import { inspectStow } from "./stow";

export interface DiagnosticReport {
  readonly healthy: boolean;
  readonly stdout: string;
}

async function signingKeyIssues(checkoutRoot: string, home: string): Promise<string[]> {
  const issues: string[] = [];
  for (const relative of ["home/.config/git/config", "home/.config/git/work_config"]) {
    let text: string;
    try {
      text = await readFile(join(checkoutRoot, relative), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const match of text.matchAll(/^\s*signingkey\s*=\s*(.+)\s*$/gim)) {
      const configured = match[1]!.trim().replace(/^['"]|['"]$/g, "");
      const path = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
      try {
        if (!(await lstat(path)).isFile()) issues.push(`signing key is not a file: ${path}`);
      } catch {
        issues.push(`signing key is missing: ${path}`);
      }
    }
  }
  return issues;
}

interface DoctorOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}

/** Accumulates the report so each check can stay a small, independently readable function. */
class DoctorLog {
  readonly lines: string[] = [];
  issues = 0;

  ok(area: string, message: string): void {
    this.lines.push(`OK    ${area}: ${message}`);
  }

  fail(area: string, message: string): void {
    this.issues += 1;
    this.lines.push(`FAIL  ${area}: ${message}`);
  }

  info(message: string): void {
    this.lines.push(`INFO  ${message}`);
  }

  /** Runs one check, reporting a thrown error as that area's failure rather than aborting the report. */
  async guard(area: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.fail(area, (error as Error).message);
    }
  }
}

async function checkCheckout(options: DoctorOptions, home: string, log: DoctorLog): Promise<void> {
  const canonical = await realpath(join(home, ".dotfiles")).catch(() => undefined);
  const checkout = await realpath(options.checkoutRoot).catch(() => undefined);
  if (!canonical) {
    log.fail("checkout", `canonical checkout is missing at ${join(home, ".dotfiles")}`);
    return;
  }
  if (checkout !== canonical) {
    log.info(`checkout: running from noncanonical checkout ${checkout}`);
    return;
  }
  await log.guard("checkout", async () => {
    await guardCanonicalCheckout(options);
    log.ok("checkout", "canonical main is clean and equal to last-fetched origin/main");
  });
}

async function checkTools(options: DoctorOptions, log: DoctorLog): Promise<Set<string>> {
  const available = new Set<string>();
  for (const tool of ["bun", "git", "brew", "stow", "pi", "frog"] as const) {
    try {
      const result = await options.processes.run({
        argv: [tool, "--version"],
        cwd: options.checkoutRoot,
        env: options.env,
      });
      if (result.exitCode === 0) {
        available.add(tool);
        log.ok("tools", `${tool} is available`);
      } else log.fail("tools", `${tool} is unavailable`);
    } catch {
      log.fail("tools", `${tool} is unavailable`);
    }
  }
  return available;
}

async function checkDeclaredPackages(options: DoctorOptions, log: DoctorLog): Promise<void> {
  await log.guard("packages", async () => {
    if (await inspectPackages(options)) log.ok("packages", "Brewfile is satisfied");
    else log.fail("packages", "Brewfile has missing declared packages; run 'dot apply'");
  });
}

async function checkGlobalBunPackages(options: DoctorOptions, log: DoctorLog): Promise<void> {
  await log.guard("bun-global", async () => {
    if (await inspectGlobalBunPackages(options)) {
      log.ok("bun-global", "declared global Bun packages are current");
    } else log.fail("bun-global", "declared global Bun packages are missing or outdated; run 'dot apply'");
  });
}

async function checkStowedDotfiles(options: DoctorOptions, home: string, log: DoctorLog): Promise<void> {
  await log.guard("dotfiles", async () => {
    const drift = await inspectStow({ checkoutRoot: options.checkoutRoot, home });
    if (drift === 0) log.ok("dotfiles", "managed paths are linked to tracked state");
    else log.fail("dotfiles", `${drift} managed path(s) drifted; run 'dot apply'`);
  });
}

async function checkPiAuth(home: string, log: DoctorLog): Promise<void> {
  const issues = await inspectPiAuth(home);
  for (const issue of issues) log.fail("pi-auth", issue);
  if (issues.length === 0) log.ok("pi-auth", "private auth is valid when configured");
}

async function checkPiSettings(options: DoctorOptions, home: string, log: DoctorLog): Promise<void> {
  const issues = await inspectPiSettings(home);
  for (const issue of issues) log.fail("pi-settings", issue);
  if (issues.length > 0) return;

  await log.guard("pi-settings", async () => {
    const plan = await planPiSettings({ checkoutRoot: options.checkoutRoot, home });
    if (plan.changed) log.fail("pi-settings", "runtime settings are stale; run 'dot apply'");
    else log.ok("pi-settings", "runtime settings are current, valid, and private");
  });
}

async function checkSkillLinks(options: DoctorOptions, log: DoctorLog): Promise<void> {
  await log.guard("skills", async () => {
    const summary = await validateSkillLinks(options);
    log.ok("skills", summary.trim().toLowerCase());
  });
}

async function checkSigningKeys(options: DoctorOptions, home: string, log: DoctorLog): Promise<void> {
  const issues = await signingKeyIssues(options.checkoutRoot, home);
  if (issues.length === 0) {
    log.ok("signing", "tracked signing keys are present");
    return;
  }
  for (const issue of issues) log.fail("signing", issue);
}

export async function runDoctor(options: DoctorOptions): Promise<DiagnosticReport> {
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");

  const log = new DoctorLog();
  await checkCheckout(options, home, log);
  const available = await checkTools(options, log);
  if (available.has("brew")) await checkDeclaredPackages(options, log);
  await checkGlobalBunPackages(options, log);
  await checkStowedDotfiles(options, home, log);
  await checkPiAuth(home, log);
  await checkPiSettings(options, home, log);
  await checkSkillLinks(options, log);
  await checkSigningKeys(options, home, log);

  log.info("freshness: based on local origin/main; no network request was made");
  log.lines.push(log.issues === 0 ? "0 actionable issues" : `${log.issues} actionable issue(s)`);
  return { healthy: log.issues === 0, stdout: `${log.lines.join("\n")}\n` };
}
