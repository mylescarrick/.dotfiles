import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { guardCanonicalCheckout } from "./checkout";
import { inspectPackages } from "./packages";
import { inspectPiSettings, planPiSettings } from "./pi";
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
      const path = configured.startsWith("~/")
        ? join(home, configured.slice(2))
        : configured;
      try {
        if (!(await lstat(path)).isFile()) issues.push(`signing key is not a file: ${path}`);
      } catch {
        issues.push(`signing key is missing: ${path}`);
      }
    }
  }
  return issues;
}

export async function runDoctor(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<DiagnosticReport> {
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");
  const lines: string[] = [];
  let issues = 0;
  const fail = (area: string, message: string) => {
    issues += 1;
    lines.push(`FAIL  ${area}: ${message}`);
  };
  const ok = (area: string, message: string) => lines.push(`OK    ${area}: ${message}`);

  const canonical = await realpath(join(home, ".dotfiles")).catch(() => undefined);
  const checkout = await realpath(options.checkoutRoot).catch(() => undefined);
  if (!canonical) {
    fail("checkout", `canonical checkout is missing at ${join(home, ".dotfiles")}`);
  } else if (checkout !== canonical) {
    lines.push(`INFO  checkout: running from noncanonical checkout ${checkout}`);
  } else {
    try {
      await guardCanonicalCheckout(options);
      ok("checkout", "canonical main is clean and equal to last-fetched origin/main");
    } catch (error) {
      fail("checkout", (error as Error).message);
    }
  }

  const available = new Set<string>();
  for (const tool of ["bun", "git", "brew", "stow"] as const) {
    try {
      const result = await options.processes.run({
        argv: [tool, "--version"],
        cwd: options.checkoutRoot,
        env: options.env,
      });
      if (result.exitCode === 0) {
        available.add(tool);
        ok("tools", `${tool} is available`);
      } else fail("tools", `${tool} is unavailable`);
    } catch {
      fail("tools", `${tool} is unavailable`);
    }
  }

  if (available.has("brew")) {
    try {
      if (await inspectPackages(options)) ok("packages", "Brewfile is satisfied");
      else fail("packages", "Brewfile has missing declared packages; run 'dot apply'");
    } catch (error) {
      fail("packages", (error as Error).message);
    }
  }

  try {
    const drift = await inspectStow({ checkoutRoot: options.checkoutRoot, home });
    if (drift === 0) ok("dotfiles", "managed paths are linked to tracked state");
    else fail("dotfiles", `${drift} managed path(s) drifted; run 'dot apply'`);
  } catch (error) {
    fail("dotfiles", (error as Error).message);
  }

  const piIssues = await inspectPiSettings(home);
  for (const issue of piIssues) fail("pi-settings", issue);
  if (piIssues.length === 0) {
    try {
      const plan = await planPiSettings({ checkoutRoot: options.checkoutRoot, home });
      if (plan.changed) {
        fail("pi-settings", "runtime settings are stale; run 'dot apply'");
      } else ok("pi-settings", "runtime settings are current, valid, and private");
    } catch (error) {
      fail("pi-settings", (error as Error).message);
    }
  }

  try {
    const summary = await validateSkillLinks(options);
    ok("skills", summary.trim().toLowerCase());
  } catch (error) {
    fail("skills", (error as Error).message);
  }

  const keyIssues = await signingKeyIssues(options.checkoutRoot, home);
  if (keyIssues.length === 0) ok("signing", "tracked signing keys are present");
  else for (const issue of keyIssues) fail("signing", issue);

  lines.push("INFO  freshness: based on local origin/main; no network request was made");
  lines.push(issues === 0 ? "0 actionable issues" : `${issues} actionable issue(s)`);
  return { healthy: issues === 0, stdout: `${lines.join("\n")}\n` };
}
