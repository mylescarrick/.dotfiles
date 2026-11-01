import { mkdir, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { replaceFileAtomic } from "./atomic-file";
import { stateDirectory } from "./deploy-record";
import type { ProcessRunner } from "./process";

export const OUTDATED_LABEL = "dev.dotfiles.outdated";
const INTERVAL_SECONDS = 6 * 60 * 60;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** launchd starts jobs with a near-empty PATH, so name the places brew, bun and node live. */
export function renderOutdatedPlist(options: {
  readonly checkoutRoot: string;
  readonly home: string;
  readonly logPath: string;
}): string {
  const path = [
    join(options.home, ".bun/bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const text = (value: string) => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${text(OUTDATED_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${text(join(options.checkoutRoot, "dot"))}
    ${text("outdated")}
    ${text("--refresh")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    ${text(options.home)}
    <key>PATH</key>
    ${text(path)}
  </dict>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  ${text(options.logPath)}
  <key>StandardErrorPath</key>
  ${text(options.logPath)}
</dict>
</plist>
`;
}

/** Only the real login account is scheduled; a test or a sandbox with its own HOME must never register a job. */
async function isRealLoginHome(home: string): Promise<boolean> {
  const [actual, login] = await Promise.all([
    realpath(home).catch(() => home),
    realpath(userInfo().homedir).catch(() => userInfo().homedir),
  ]);
  return actual === login;
}

export async function ensureOutdatedSchedule(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly processes: ProcessRunner;
}): Promise<string> {
  if (process.platform !== "darwin" || !(await isRealLoginHome(options.home))) return "";

  const plistPath = join(options.home, "Library/LaunchAgents", `${OUTDATED_LABEL}.plist`);
  const desired = renderOutdatedPlist({
    checkoutRoot: options.checkoutRoot,
    home: options.home,
    logPath: join(stateDirectory(options.env, options.home), "outdated.log"),
  });
  const current = await readFile(plistPath, "utf8").catch(() => undefined);
  const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
  const run = (argv: [string, ...string[]]) =>
    options.processes.run({ argv, cwd: options.checkoutRoot, env: options.env });

  const loaded = (await run(["launchctl", "print", `${domain}/${OUTDATED_LABEL}`])).exitCode === 0;
  if (current === desired && loaded) return "Background outdated check already scheduled\n";

  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(stateDirectory(options.env, options.home), { recursive: true });
  if (current !== desired) await replaceFileAtomic(plistPath, desired);
  if (loaded) await run(["launchctl", "bootout", `${domain}/${OUTDATED_LABEL}`]);
  const boot = await run(["launchctl", "bootstrap", domain, plistPath]);
  if (boot.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
  return "Background outdated check scheduled (every 6 hours)\n";
}
