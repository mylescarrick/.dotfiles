import type { ProcessRunner } from "./process";
import type { Terminal } from "./terminal";

const RED = "\u001B[31m";
const RESET = "\u001B[39m";

interface AdminOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}

async function currentUser(options: AdminOptions): Promise<string | undefined> {
  const result = await options.processes.run({
    argv: ["id", "-un"],
    cwd: options.checkoutRoot,
    env: options.env,
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * Whether the invoking account currently holds admin rights. Under Jamf Connect-style
 * just-in-time elevation this flips during a session, so it is read live from directory
 * services rather than trusted from the shell's cached group set.
 */
export async function hasAdminPrivileges(options: AdminOptions): Promise<boolean | undefined> {
  const user = await currentUser(options);
  if (!user) return undefined;

  try {
    const result = await options.processes.run({
      argv: ["dseditgroup", "-o", "checkmember", "-m", user, "admin"],
      cwd: options.checkoutRoot,
      env: options.env,
    });
    return result.exitCode === 0;
  } catch {
    return undefined;
  }
}

/**
 * Casks land in /Applications, which is owned by root:admin. Without elevation Homebrew
 * still stages the app under the Caskroom and only fails when it moves it into place,
 * leaving a receipt that `brew bundle check` reports as satisfied. Warn before that happens.
 */
export async function warnWithoutAdminPrivileges(
  options: AdminOptions & { readonly terminal: Terminal }
): Promise<void> {
  if ((await hasAdminPrivileges(options)) !== false) return;

  const message =
    "WARNING: you are not currently an admin. Homebrew cask installs into /Applications will fail, and leave behind a receipt that looks installed. Elevate first, then re-run.";
  options.terminal.write(options.terminal.interactive ? `${RED}${message}${RESET}\n` : `${message}\n`);
}
