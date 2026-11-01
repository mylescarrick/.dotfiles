import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
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
  /** The state directory in force when this was installed; the job must write where doctor reads. */
  readonly stateHome?: string;
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
    ${text(path)}${
      options.stateHome
        ? `
    <key>XDG_STATE_HOME</key>
    ${text(options.stateHome)}`
        : ""
    }
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

interface ScheduleOptions {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** The account that owns the machine; defaults to the logged-in user. Tests pass their own. */
  readonly loginHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly processes: ProcessRunner;
}

export type ScheduleStatus =
  | "current"
  | "disable-incomplete"
  | "disabled"
  | "file-differs"
  | "missing"
  | "not-applicable"
  | "not-loaded";

/** Only the real login account is scheduled; a test or a sandbox with its own HOME must never register a job. */
async function isLoginHome(home: string, loginHome: string): Promise<boolean> {
  const [actual, login] = await Promise.all([
    realpath(home).catch(() => home),
    realpath(loginHome).catch(() => loginHome),
  ]);
  return actual === login;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

function disabledMarker(options: ScheduleOptions): string {
  return join(stateDirectory(options.env, options.home), "outdated.disabled");
}

function plistPathFor(options: ScheduleOptions): string {
  return join(options.home, "Library/LaunchAgents", `${OUTDATED_LABEL}.plist`);
}

function desiredPlist(options: ScheduleOptions): string {
  return renderOutdatedPlist({
    checkoutRoot: options.checkoutRoot,
    home: options.home,
    logPath: join(stateDirectory(options.env, options.home), "outdated.log"),
    stateHome: options.env.XDG_STATE_HOME || undefined,
  });
}

function domainFor(): string {
  return `gui/${process.getuid?.() ?? userInfo().uid}`;
}

function launchctl(options: ScheduleOptions, argv: [string, ...string[]]) {
  return options.processes.run({ argv, cwd: options.checkoutRoot, env: options.env });
}

export interface LaunchdState {
  /** The exit code of the most recent finished run, when launchd has one. */
  readonly lastExit?: number;
  readonly loaded: boolean;
  readonly running?: boolean;
  readonly runs?: number;
}

/** Reads what launchd itself recorded about the job: whether it is running, how often it ran, how the last run ended. */
export function parseLaunchdPrint(stdout: string): Omit<LaunchdState, "loaded"> {
  const runs = stdout.match(/^\s*runs = (\d+)/m)?.[1];
  const exit = stdout.match(/^\s*last exit code = (-?\d+)/m)?.[1];
  const state = stdout.match(/^\s*state = ([a-z ]+)$/m)?.[1];
  return {
    lastExit: exit === undefined ? undefined : Number(exit),
    running: state === undefined ? undefined : state === "running",
    runs: runs === undefined ? undefined : Number(runs),
  };
}

export async function launchdState(options: ScheduleOptions): Promise<LaunchdState> {
  const result = await launchctl(options, ["launchctl", "print", `${domainFor()}/${OUTDATED_LABEL}`]);
  return result.exitCode === 0 ? { loaded: true, ...parseLaunchdPrint(result.stdout) } : { loaded: false };
}

async function isLoaded(options: ScheduleOptions): Promise<boolean> {
  return (await launchdState(options)).loaded;
}

async function applicable(options: ScheduleOptions): Promise<boolean> {
  return (
    (options.platform ?? process.platform) === "darwin" &&
    (await isLoginHome(options.home, options.loginHome ?? userInfo().homedir))
  );
}

/** One answer to "is the background job right?", shared by apply and doctor so they cannot disagree. */
export async function inspectOutdatedSchedule(options: ScheduleOptions): Promise<ScheduleStatus> {
  if (!(await applicable(options))) return "not-applicable";
  if (
    await stat(disabledMarker(options)).then(
      () => true,
      () => false
    )
  ) {
    // The marker says off; a file or a loaded job that outlived it means turning it off did not finish.
    const lingering = (await exists(plistPathFor(options))) || (await isLoaded(options));
    return lingering ? "disable-incomplete" : "disabled";
  }
  const current = await readFile(plistPathFor(options), "utf8").catch(() => undefined);
  if (current === undefined) return (await isLoaded(options)) ? "file-differs" : "missing";
  if (current !== desiredPlist(options)) return "file-differs";
  return (await isLoaded(options)) ? "current" : "not-loaded";
}

/** Unloads the job if launchd has it, and fails loudly if it is still there afterwards. */
async function unload(options: ScheduleOptions): Promise<void> {
  if (!(await isLoaded(options))) return;
  const result = await launchctl(options, ["launchctl", "bootout", `${domainFor()}/${OUTDATED_LABEL}`]);
  // bootout can report an error for a job that is in fact gone, so the check is whether it is still loaded.
  if (result.exitCode !== 0 && (await isLoaded(options))) {
    throw new Error(`launchctl bootout failed and the job is still running: ${result.stderr.trim()}`);
  }
}

async function removeSchedule(options: ScheduleOptions): Promise<boolean> {
  if (!(await applicable(options))) return false;
  const plistPath = plistPathFor(options);
  const present = await exists(plistPath);
  const wasLoaded = await isLoaded(options);
  await unload(options);
  await rm(plistPath, { force: true });
  return present || wasLoaded;
}

async function install(options: ScheduleOptions, status: ScheduleStatus): Promise<void> {
  const plistPath = plistPathFor(options);
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(stateDirectory(options.env, options.home), { recursive: true });
  // Unload first, always: a job registered from an old or deleted file would otherwise make
  // bootstrap fail, or leave the old definition running behind a new file.
  await unload(options);
  if (status === "missing" || status === "file-differs")
    await replaceFileAtomic(plistPath, desiredPlist(options));
  const boot = await launchctl(options, ["launchctl", "bootstrap", domainFor(), plistPath]);
  if (boot.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
}

export async function ensureOutdatedSchedule(options: ScheduleOptions): Promise<string> {
  const status = await inspectOutdatedSchedule(options);
  if (status === "not-applicable") return "";
  if (status === "disabled") return "";
  if (status === "disable-incomplete") {
    // Turning it off must stick even if the file or job outlived the marker.
    await removeSchedule(options);
    return "Background outdated check removed (disabled)\n";
  }
  if (status === "current") return "Background outdated check already scheduled\n";
  await install(options, status);
  return "Background outdated check scheduled (every 6 hours)\n";
}

/** Turns the background check off and keeps it off: `dot apply` respects the marker. */
export async function disableOutdatedSchedule(options: ScheduleOptions): Promise<string> {
  await mkdir(stateDirectory(options.env, options.home), { recursive: true });
  await replaceFileAtomic(disabledMarker(options), "disabled by `dot outdated --disable`\n");
  const removed = await removeSchedule(options);
  return `Background outdated check disabled${removed ? " and removed" : ""}. Turn it back on with 'dot outdated --enable'.\n`;
}

export async function enableOutdatedSchedule(options: ScheduleOptions): Promise<string> {
  await rm(disabledMarker(options), { force: true });
  const message = await ensureOutdatedSchedule(options);
  return message || "Background outdated check enabled (nothing to schedule on this machine).\n";
}

const DAY_MS = 86_400_000;

export interface Freshness {
  readonly level: "fail" | "info" | "ok";
  readonly message: string;
}

/**
 * Whether the background job is doing its work. The clock alone cannot tell a sleeping Mac from
 * a broken job, so this leans on what launchd recorded: a failed last run, or runs that wrote
 * nothing, are real failures; a result that is merely old is only noted, since the job runs
 * while the Mac is awake and a long sleep looks identical to a stall.
 */
export function judgeFreshness(input: {
  checkedAt?: string;
  lastExit?: number;
  now: Date;
  running?: boolean;
  runs?: number;
}): Freshness {
  const ran = (input.runs ?? 0) >= 1;
  if (ran && input.lastExit !== undefined && input.lastExit !== 0) {
    return {
      level: "fail",
      message: `the last background run failed (exit ${input.lastExit}); see outdated.log`,
    };
  }
  if (!input.checkedAt) {
    if (input.running) return { level: "info", message: "background job is running its first check" };
    return ran
      ? {
          level: "fail",
          message: `the background job has run ${input.runs} time(s) but wrote no result; see outdated.log`,
        }
      : { level: "info", message: "background job is installed and has not run yet" };
  }
  const days = (input.now.getTime() - Date.parse(input.checkedAt)) / DAY_MS;
  if (days > 2) {
    return {
      level: "info",
      message: `last background result is ${Math.floor(days)} days old; it refreshes while the Mac is awake`,
    };
  }
  return { level: "ok", message: "background job is loaded and results are recent" };
}
