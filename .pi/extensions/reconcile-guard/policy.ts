import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * What the reconcile agent may not do. This stops accidents and obvious detours; it is not a
 * sandbox (a script it writes can do anything). The checks `dot` runs after the session are the
 * real control: allowlisted paths, a clean tree, no pre-pushed branch, `main` unmoved.
 */

interface Rule {
  readonly pattern: RegExp;
  readonly reason: string;
}

const NO_PUSH = "dot pushes the branch and opens the PR after you finish. Commit instead.";
const NO_INSTALL =
  "Never change what is installed on this Mac; edit the tracked file and tell the user the command.";

const BLOCKED: readonly Rule[] = [
  { pattern: /\bgit\b[^;&|\n]*\b(push|remote|config)\b/, reason: NO_PUSH },
  { pattern: /--no-verify\b/, reason: "Hooks and secret scans must run on every commit." },
  { pattern: /(?:^|[\s;&|(])gh\s/, reason: NO_PUSH },
  { pattern: /\bsudo\b/, reason: "No elevated commands in a reconcile session." },
  {
    pattern: /\bbrew\s+(install|uninstall|remove|upgrade|reinstall|tap|untap|update|link|unlink)\b/,
    reason: NO_INSTALL,
  },
  {
    pattern: /\b(bun|npm|pnpm|yarn)\s+(add|remove|rm|install|i|update|upgrade)\b[^;&|\n]*(-g|--global)\b/,
    reason: NO_INSTALL,
  },
  { pattern: /\b(bun|npm|pnpm|yarn)\s+(-g|--global)\b/, reason: NO_INSTALL },
  { pattern: /\bpi\s+(install|remove|uninstall|update)\b/, reason: NO_INSTALL },
  { pattern: /\bskills\s+(add|remove|update)\b/, reason: NO_INSTALL },
  {
    pattern: /(?:^|[\s;&|(])dot\s+(apply|update|upgrade|reconcile|init|drift\s+(restore|ignore))\b/,
    reason: "dot runs those after you finish; tell the user the command instead.",
  },
];

const WRITERS_ALL_INSIDE = new Set([
  "rm",
  "ln",
  "tee",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "truncate",
  "install",
  "mv",
]);
const WRITERS_LAST_INSIDE = new Set(["cp", "rsync"]);

function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, ""));
}

function expand(path: string, worktree: string): string {
  const home = process.env.HOME ?? "";
  const expanded = path === "~" || path.startsWith("~/") ? home + path.slice(1) : path;
  return resolve(worktree, expanded);
}

export function isInside(path: string, worktree: string): boolean {
  const target = expand(path, worktree);
  const roots = [worktree, tmpdir(), "/tmp", "/private/tmp"];
  return roots.some((root) => target === root || target.startsWith(`${root}/`)) || target === "/dev/null";
}

function pathArgs(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

function outsideWrite(segment: string, worktree: string): string | undefined {
  const parts = words(segment);
  const command = parts.find((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
  if (!command) return undefined;
  const args = parts.slice(parts.indexOf(command) + 1);
  const fail = (path: string) =>
    `Blocked: ${path} is outside the worktree. Reconcile may only change files in ${worktree}.`;

  if (WRITERS_ALL_INSIDE.has(command)) {
    const bad = pathArgs(args).find((arg) => !isInside(arg, worktree));
    if (bad) return fail(bad);
  }
  if (WRITERS_LAST_INSIDE.has(command)) {
    const last = pathArgs(args).at(-1);
    if (last && !isInside(last, worktree)) return fail(last);
  }
  if ((command === "sed" || command === "perl") && args.some((arg) => /^-[a-z]*i/.test(arg))) {
    const bad = pathArgs(args)
      .slice(1)
      .find((arg) => !isInside(arg, worktree));
    if (bad) return fail(bad);
  }
  const gitDir = command === "git" ? args[args.indexOf("-C") + 1] : undefined;
  if (args.includes("-C") && gitDir && !isInside(gitDir, worktree)) return fail(gitDir);
  const redirect = segment.match(/>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/);
  const target = redirect?.[1]?.replace(/^["']|["']$/g, "");
  if (target && !target.startsWith("&") && !isInside(target, worktree)) return fail(target);
  return undefined;
}

/** A reason to block this shell command, or undefined to allow it. */
export function checkBash(command: string, worktree: string): string | undefined {
  for (const rule of BLOCKED) if (rule.pattern.test(command)) return `Blocked: ${rule.reason}`;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const reason = outsideWrite(segment.trim(), worktree);
    if (reason) return reason;
  }
  return undefined;
}

/** A reason to block a write or edit of this path, or undefined to allow it. */
export function checkWritePath(path: string, worktree: string): string | undefined {
  if (isInside(path, worktree)) return undefined;
  return `Blocked: ${path} is outside the worktree. Reconcile may only change files in ${worktree}.`;
}
