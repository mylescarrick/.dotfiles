import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import type { ProcessRequest, ProcessRunner } from "../src/process";
import {
  disableOutdatedSchedule,
  enableOutdatedSchedule,
  ensureOutdatedSchedule,
  inspectOutdatedSchedule,
  judgeFreshness,
  launchdState,
} from "../src/schedule";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

/**
 * A launchd that is as strict as the real one about what the tests could get wrong: it checks
 * the service target, rejects registering a job that is already loaded, and can refuse to unload.
 */
class FakeLaunchd implements ProcessRunner {
  failBootout = false as boolean;
  lastExit = "0" as string;
  loaded = false as boolean;
  running = false as boolean;
  runs = 1;
  readonly calls: string[] = [];
  private readonly domain = `gui/${process.getuid?.() ?? 0}`;

  run(request: ProcessRequest) {
    const [, verb, target] = request.argv;
    this.calls.push(verb as string);
    const service = `${this.domain}/dev.dotfiles.outdated`;
    let exitCode = 0;
    if (verb === "print") exitCode = target === service && this.loaded ? 0 : 113;
    else if (verb === "bootout") {
      if (target !== service) exitCode = 113;
      else if (this.failBootout) exitCode = 5;
      else this.loaded = false;
    } else if (verb === "bootstrap") {
      if (target !== this.domain) exitCode = 125;
      else if (this.loaded) exitCode = 5;
      else this.loaded = true;
    }
    // The same top-level lines real `launchctl print` shows (state first, nested "active" states after).
    const stdout =
      verb === "print" && exitCode === 0
        ? `${service} = {\n\tstate = ${this.running ? "running" : "not running"}\n\truns = ${this.runs}\n\tlast exit code = ${this.lastExit}\n\t\tstate = active\n}\n`
        : "";
    return Promise.resolve({ exitCode, stderr: exitCode ? "launchctl: refused" : "", stdout });
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dot-schedule-"));
  temporaryDirectories.push(home);
  const launchd = new FakeLaunchd();
  const options = {
    checkoutRoot: join(home, ".dotfiles"),
    env: { HOME: home, XDG_STATE_HOME: join(home, "state") },
    home,
    loginHome: home,
    platform: "darwin" as const,
    processes: launchd,
  };
  const plist = join(home, "Library/LaunchAgents/dev.dotfiles.outdated.plist");
  const marker = join(home, "state/dot/outdated.disabled");
  return { home, launchd, marker, options, plist };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

describe("background outdated job state", () => {
  test("installs a missing job once, then recognises it as current", async () => {
    const { launchd, options, plist } = await fixture();

    expect(await inspectOutdatedSchedule(options)).toBe("missing");
    expect(await ensureOutdatedSchedule(options)).toBe(
      "Background outdated check scheduled (every 6 hours)\n"
    );
    const written = await readFile(plist, "utf8");
    expect(written).toContain("<string>--refresh</string>");
    // The job must write where doctor reads, even when the shell sets a custom state directory.
    expect(written).toContain(
      `<key>XDG_STATE_HOME</key>\n    <string>${options.env.XDG_STATE_HOME}</string>`
    );
    expect(launchd.calls.filter((verb) => verb === "bootstrap")).toHaveLength(1);

    expect(await inspectOutdatedSchedule(options)).toBe("current");
    expect(await ensureOutdatedSchedule(options)).toBe("Background outdated check already scheduled\n");
    expect(launchd.calls.filter((verb) => verb === "bootstrap")).toHaveLength(1);
  });

  test("rewrites a stale file and reloads it, so launchd does not keep the old definition", async () => {
    const { launchd, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);
    await writeFile(plist, "<plist>old</plist>\n");
    launchd.calls.length = 0;

    expect(await inspectOutdatedSchedule(options)).toBe("file-differs");
    await ensureOutdatedSchedule(options);

    expect(await readFile(plist, "utf8")).toContain("dev.dotfiles.outdated");
    expect(launchd.calls).toEqual(["print", "bootout", "bootstrap"]);
  });

  test("loads a job whose file is right but which launchd dropped, without rewriting the file", async () => {
    const { launchd, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);
    launchd.loaded = false;
    const before = (await stat(plist)).mtimeMs;

    expect(await inspectOutdatedSchedule(options)).toBe("not-loaded");
    await ensureOutdatedSchedule(options);

    expect(launchd.loaded).toBe(true);
    expect((await stat(plist)).mtimeMs).toBe(before);
  });
});

describe("recovering from half-finished states", () => {
  test("a job still loaded after its file was deleted is unloaded before it is installed again", async () => {
    const { launchd, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);
    await rm(plist);
    launchd.calls.length = 0;

    expect(await inspectOutdatedSchedule(options)).toBe("file-differs");
    await ensureOutdatedSchedule(options);

    expect(launchd.calls.indexOf("bootout")).toBeGreaterThanOrEqual(0);
    expect(launchd.calls.indexOf("bootout")).toBeLessThan(launchd.calls.indexOf("bootstrap"));
    expect(await readFile(plist, "utf8")).toContain("dev.dotfiles.outdated");
    expect(await inspectOutdatedSchedule(options)).toBe("current");
  });

  test("an unload that fails is reported and leaves the old file alone, so the install can be retried", async () => {
    const { launchd, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);
    await writeFile(plist, "<plist>old</plist>\n");
    launchd.failBootout = true;

    await expect(ensureOutdatedSchedule(options)).rejects.toThrow(
      "bootout failed and the job is still running"
    );
    expect(await readFile(plist, "utf8")).toBe("<plist>old</plist>\n");

    launchd.failBootout = false;
    await ensureOutdatedSchedule(options);
    expect(await inspectOutdatedSchedule(options)).toBe("current");
  });

  test("disabling while launchd refuses to unload is not reported as done, and stays visible until apply fixes it", async () => {
    const { launchd, marker, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);
    launchd.failBootout = true;

    await expect(disableOutdatedSchedule(options)).rejects.toThrow("still running");
    expect(await exists(marker)).toBe(true);
    expect(await exists(plist)).toBe(true);
    expect(await inspectOutdatedSchedule(options)).toBe("disable-incomplete");

    launchd.failBootout = false;
    expect(await ensureOutdatedSchedule(options)).toContain("removed (disabled)");
    expect(await inspectOutdatedSchedule(options)).toBe("disabled");
    expect(launchd.loaded).toBe(false);
  });
});

describe("reading what launchd recorded", () => {
  test("takes the top-level state, run count and last exit code from launchctl print", async () => {
    const { launchd, options } = await fixture();
    await ensureOutdatedSchedule(options);
    launchd.runs = 4;
    launchd.lastExit = "78";

    expect(await launchdState(options)).toEqual({ lastExit: 78, loaded: true, running: false, runs: 4 });

    launchd.running = true;
    launchd.lastExit = "(never exited)";
    expect(await launchdState(options)).toMatchObject({ lastExit: undefined, running: true });
  });
});

describe("judging whether the background job is doing its work", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  test("a job that is running its first check, or has not run yet, is not a failure", () => {
    expect(judgeFreshness({ now, running: true, runs: 1 }).level).toBe("info");
    expect(judgeFreshness({ now, runs: 0 }).level).toBe("info");
    expect(judgeFreshness({ now }).level).toBe("info");
  });

  test("runs that wrote nothing, or a last run that failed, are failures", () => {
    expect(judgeFreshness({ lastExit: 0, now, runs: 3 })).toMatchObject({ level: "fail" });
    expect(judgeFreshness({ checkedAt: ago(1), lastExit: 127, now, runs: 3 })).toMatchObject({
      level: "fail",
      message: "the last background run failed (exit 127); see outdated.log",
    });
  });

  test("an old result after a clean last run is only noted, however long the Mac slept", () => {
    expect(judgeFreshness({ checkedAt: ago(24), lastExit: 0, now, runs: 9 }).level).toBe("ok");
    expect(judgeFreshness({ checkedAt: ago(72), lastExit: 0, now, runs: 9 }).level).toBe("info");
    expect(judgeFreshness({ checkedAt: ago(24 * 30), lastExit: 0, now, runs: 9 }).level).toBe("info");
  });
});

describe("turning the background job off and on", () => {
  test("disable removes the job and apply keeps it off; enable brings it back", async () => {
    const { launchd, marker, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);

    expect(await disableOutdatedSchedule(options)).toContain("disabled and removed");
    expect(await exists(plist)).toBe(false);
    expect(launchd.loaded).toBe(false);
    expect(await exists(marker)).toBe(true);

    expect(await inspectOutdatedSchedule(options)).toBe("disabled");
    expect(await ensureOutdatedSchedule(options)).toBe("");
    expect(await exists(plist)).toBe(false);

    expect(await enableOutdatedSchedule(options)).toContain("scheduled");
    expect(await exists(marker)).toBe(false);
    expect(await exists(plist)).toBe(true);
    expect(launchd.loaded).toBe(true);
  });

  test("a marker made by hand is enough: apply removes a job that outlived it", async () => {
    const { launchd, marker, options, plist } = await fixture();
    await ensureOutdatedSchedule(options);
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "off\n");

    expect(await ensureOutdatedSchedule(options)).toContain("removed (disabled)");
    expect(await exists(plist)).toBe(false);
    expect(launchd.loaded).toBe(false);
  });

  test("on a machine that is not the login account, disable only records the choice and nothing is reported", async () => {
    const { home, launchd, marker, options } = await fixture();
    const sandboxed = { ...options, loginHome: join(home, "someone-else") };

    expect(await disableOutdatedSchedule(sandboxed)).toBe(
      "Background outdated check disabled. Turn it back on with 'dot outdated --enable'.\n"
    );
    expect(await exists(marker)).toBe(true);
    expect(launchd.calls).toEqual([]);
    expect(await inspectOutdatedSchedule(sandboxed)).toBe("not-applicable");
  });

  test("the command exposes both switches and rejects anything else", async () => {
    const { home, options } = await fixture();
    const app = createApplication({ checkoutRoot: options.checkoutRoot, processes: options.processes });
    const run = (argv: string[]) => app.execute({ argv, cwd: home, env: options.env });

    expect((await run(["outdated", "--disable"])).stdout).toContain("Background outdated check disabled");
    expect((await run(["outdated", "--enable"])).exitCode).toBe(0);
    expect(await run(["outdated", "--nope"])).toMatchObject({
      exitCode: 2,
      stderr: "dot: usage: dot outdated [--refresh | --disable | --enable]\n",
    });
  });
});
