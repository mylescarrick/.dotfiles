import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOutdated, describeOutdated, parseBrewOutdated } from "../src/outdated";
import type { ProcessRequest, ProcessRunner } from "../src/process";
import { ensureOutdatedSchedule, renderOutdatedPlist } from "../src/schedule";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const BREW_JSON = JSON.stringify({
  casks: [{ current_version: "2.0", installed_versions: "1.0", name: "zoom" }],
  formulae: [{ current_version: "2026.10.7", installed_versions: ["2026.10.3"], name: "cloudflared" }],
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dot-outdated-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "dotfiles");
  const home = join(root, "home");
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await mkdir(join(checkout, "packages"), { recursive: true });
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    JSON.stringify({
      packages: ["npm:fresh-pkg", "npm:stale-pkg", "npm:@scope/pinned@1.0.0", "npm:not-installed"],
    })
  );
  await writeFile(join(checkout, "packages/bun-global"), "pinned-tool@1.0.0\nold-tool\nnew-tool\n");
  for (const [name, version] of [
    ["fresh-pkg", "3.0.0"],
    ["stale-pkg", "1.0.0"],
    ["@scope/pinned", "1.0.0"],
  ] as const) {
    await mkdir(join(home, ".pi/agent/npm/node_modules", name), { recursive: true });
    await writeFile(
      join(home, ".pi/agent/npm/node_modules", name, "package.json"),
      JSON.stringify({ version })
    );
  }
  return { checkout, home };
}

function fakeProcesses(overrides: { brewFails?: boolean } = {}): ProcessRunner {
  return {
    run(request: ProcessRequest) {
      const [command, ...rest] = request.argv;
      if (command === "brew") {
        if (overrides.brewFails) return Promise.resolve({ exitCode: 1, stderr: "locked", stdout: "" });
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: rest[0] === "outdated" ? BREW_JSON : "" });
      }
      if (command === "bun") {
        const stdout = "├── pinned-tool@1.0.0\n├── old-tool@1.0.0\n└── new-tool@5.0.0\n";
        return Promise.resolve({ exitCode: 0, stderr: "", stdout });
      }
      return Promise.reject(new Error(`unexpected ${request.argv.join(" ")}`));
    },
  };
}

const LATEST: Record<string, string> = {
  "fresh-pkg": "3.0.0",
  "new-tool": "4.0.0",
  "old-tool": "2.0.0",
  "pinned-tool": "9.0.0",
  "stale-pkg": "1.2.0",
};

describe("outdated check", () => {
  test("reads formulae and casks from brew's json", () => {
    expect(parseBrewOutdated(BREW_JSON)).toEqual([
      { installed: "2026.10.3", latest: "2026.10.7", name: "cloudflared" },
      { installed: "1.0", latest: "2.0", name: "zoom" },
    ]);
  });

  test("flags only what is genuinely behind, and skips pinned, newer and uninstalled packages", async () => {
    const { checkout, home } = await fixture();
    const report = await collectOutdated({
      checkoutRoot: checkout,
      env: process.env,
      home,
      latestVersion: (name) => Promise.resolve(LATEST[name]),
      processes: fakeProcesses(),
    });

    expect(report.brew.map((item) => item.name)).toEqual(["cloudflared", "zoom"]);
    expect(report.bun).toEqual([{ installed: "1.0.0", latest: "2.0.0", name: "old-tool" }]);
    expect(report.pi).toEqual([{ installed: "1.0.0", latest: "1.2.0", name: "stale-pkg" }]);
    expect(report.errors).toEqual([]);
  });

  test("a source that cannot be checked keeps its previous result and says so", async () => {
    const { checkout, home } = await fixture();
    const previous = await collectOutdated({
      checkoutRoot: checkout,
      env: process.env,
      home,
      latestVersion: (name) => Promise.resolve(LATEST[name]),
      processes: fakeProcesses(),
    });

    const report = await collectOutdated({
      checkoutRoot: checkout,
      env: process.env,
      home,
      latestVersion: (name) => Promise.resolve(LATEST[name]),
      previous,
      processes: fakeProcesses({ brewFails: true }),
    });

    expect(report.brew).toEqual(previous.brew);
    expect(report.errors).toEqual(["brew: brew update failed: locked"]);
    expect(report.pi).toEqual(previous.pi);
  });

  test("describes names, versions and how fresh the check is", () => {
    const text = describeOutdated(
      {
        brew: [{ installed: "1.0", latest: "2.0", name: "zoom" }],
        bun: [],
        checkedAt: "2026-11-01T08:00:00.000Z",
        errors: ["pi: offline"],
        pi: [],
      },
      new Date("2026-11-01T11:00:00.000Z")
    );

    expect(text).toContain("1 update(s) available (checked 3 h ago):");
    expect(text).toContain("    zoom  1.0 -> 2.0");
    expect(text).toContain("could not check pi: offline");
    expect(describeOutdated(undefined)).toContain("dot outdated --refresh");
  });
});

describe("background schedule", () => {
  test("the job runs dot outdated --refresh with a PATH that can find brew and bun", () => {
    const plist = renderOutdatedPlist({
      checkoutRoot: "/Users/x/.dotfiles",
      home: "/Users/x",
      logPath: "/tmp/l.log",
    });

    expect(plist).toContain("<string>dev.dotfiles.outdated</string>");
    expect(plist).toContain("<string>/Users/x/.dotfiles/dot</string>");
    expect(plist).toContain("<string>--refresh</string>");
    expect(plist).toContain("/Users/x/.bun/bin:/opt/homebrew/bin");
    expect(plist).toContain("<integer>21600</integer>");
  });

  test("never registers a job for a home that is not the login account's", async () => {
    const { checkout, home } = await fixture();
    const calls: string[] = [];
    const processes: ProcessRunner = {
      run(request) {
        calls.push(request.argv.join(" "));
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
    };

    expect(await ensureOutdatedSchedule({ checkoutRoot: checkout, env: process.env, home, processes })).toBe(
      ""
    );
    expect(calls).toEqual([]);
  });
});
