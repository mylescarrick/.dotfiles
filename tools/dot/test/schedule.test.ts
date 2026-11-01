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
} from "../src/schedule";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

/** A launchd that only remembers whether the job is loaded, and what it was asked to do. */
class FakeLaunchd implements ProcessRunner {
  loaded = false;
  readonly calls: string[] = [];

  run(request: ProcessRequest) {
    const [, verb] = request.argv;
    this.calls.push(verb as string);
    if (verb === "bootstrap") this.loaded = true;
    if (verb === "bootout") this.loaded = false;
    const ok = verb !== "print" || this.loaded;
    return Promise.resolve({ exitCode: ok ? 0 : 1, stderr: "", stdout: "" });
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
    expect(await readFile(plist, "utf8")).toContain("<string>--refresh</string>");
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

  test("on a machine that is not the login account, disable only records the choice", async () => {
    const { home, launchd, marker, options } = await fixture();
    const sandboxed = { ...options, loginHome: join(home, "someone-else") };

    expect(await disableOutdatedSchedule(sandboxed)).toBe(
      "Background outdated check disabled. Turn it back on with 'dot outdated --enable'.\n"
    );
    expect(await exists(marker)).toBe(true);
    expect(launchd.calls).toEqual([]);
    expect(await inspectOutdatedSchedule(sandboxed)).toBe("disabled");
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
