import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import type { Terminal } from "../src/terminal";

const temporaryDirectories: string[] = [];

async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function makeFixture(tracked: Record<string, string>): Promise<{
  checkout: string;
  env: Record<string, string>;
  home: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-apply-stow-")));
  temporaryDirectories.push(home);
  const checkout = join(home, ".dotfiles");
  await mkdir(join(checkout, "config/pi"), { recursive: true });
  await mkdir(join(checkout, "home"), { recursive: true });
  await writeFile(
    join(checkout, "config/pi/settings.defaults.json"),
    '{"theme":"dark","packages":[]}\n',
  );
  for (const [relative, content] of Object.entries(tracked)) {
    const path = join(checkout, "home", relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "config", "user.name", "Dot Tests"], checkout);
  await run(["git", "config", "user.email", "dot@example.test"], checkout);
  await run(["git", "add", "."], checkout);
  await run(["git", "commit", "-m", "fixture"], checkout);
  const head = await run(["git", "rev-parse", "HEAD"], checkout);
  await run(["git", "update-ref", "refs/remotes/origin/main", head], checkout);
  return { checkout, home, env: { ...process.env, HOME: home } };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function scriptedTerminal(
  answers: string[],
  beforeAnswer?: () => Promise<void>,
): Terminal & { output: string } {
  return {
    interactive: true,
    output: "",
    async prompt() {
      await beforeAnswer?.();
      return answers.shift() ?? "";
    },
    write(message) {
      this.output += message;
    },
  };
}

describe("dot apply stow", () => {
  test("backs up a differing live file before stowing tracked state", async () => {
    const fixture = await makeFixture({ ".config/example/config.txt": "tracked\n" });
    const livePath = join(fixture.home, ".config/example/config.txt");
    await mkdir(join(livePath, ".."), { recursive: true });
    await writeFile(livePath, "live\n");

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply", "--yes"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect((await lstat(livePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(livePath, "utf8")).toBe("tracked\n");
    const roots = await readdir(join(fixture.checkout, "backups/stow-conflicts"));
    expect(roots).toHaveLength(1);
    expect(
      await readFile(
        join(
          fixture.checkout,
          "backups/stow-conflicts",
          roots[0]!,
          ".config/example/config.txt",
        ),
        "utf8",
      ),
    ).toBe("live\n");
  });

  test("keeps an interactive live file while stowing unrelated paths", async () => {
    const fixture = await makeFixture({ ".config/a": "tracked a\n", ".config/b": "tracked b\n" });
    const conflict = join(fixture.home, ".config/a");
    await mkdir(join(conflict, ".."), { recursive: true });
    await writeFile(conflict, "live a\n");
    const terminal = scriptedTerminal(["k"]);

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      terminal,
    }).execute({ argv: ["apply"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(0);
    expect(await readFile(conflict, "utf8")).toBe("live a\n");
    expect((await lstat(join(fixture.home, ".config/b"))).isSymbolicLink()).toBe(true);
  });

  test("interactive abort leaves every tracked path unapplied", async () => {
    const fixture = await makeFixture({ ".config/a": "tracked a\n", ".config/b": "tracked b\n" });
    const conflict = join(fixture.home, ".config/a");
    await mkdir(join(conflict, ".."), { recursive: true });
    await writeFile(conflict, "live a\n");

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      terminal: scriptedTerminal(["a"]),
    }).execute({ argv: ["apply"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(1);
    expect(await readFile(conflict, "utf8")).toBe("live a\n");
    expect(await Bun.file(join(fixture.home, ".config/b")).exists()).toBe(false);
  });

  test("refuses to move a conflict changed after planning", async () => {
    const fixture = await makeFixture({ ".config/a": "tracked a\n", ".config/b": "tracked b\n" });
    const conflict = join(fixture.home, ".config/a");
    await mkdir(join(conflict, ".."), { recursive: true });
    await writeFile(conflict, "live a\n");
    const terminal = scriptedTerminal(["u"], async () => {
      await writeFile(conflict, "changed during prompt\n");
    });

    const outcome = await createApplication({
      checkoutRoot: fixture.checkout,
      terminal,
    }).execute({ argv: ["apply"], cwd: fixture.checkout, env: fixture.env });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("changed while stow was being planned");
    expect(await readFile(conflict, "utf8")).toBe("changed during prompt\n");
    expect(await Bun.file(join(fixture.home, ".config/b")).exists()).toBe(false);
  });

  test("refuses a noninteractive conflict without --yes before mutation", async () => {
    const fixture = await makeFixture({ ".config/a": "tracked a\n", ".config/b": "tracked b\n" });
    const conflict = join(fixture.home, ".config/a");
    await mkdir(join(conflict, ".."), { recursive: true });
    await writeFile(conflict, "live a\n");

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("conflicts with tracked state; rerun with --yes");
    expect(await readFile(conflict, "utf8")).toBe("live a\n");
    expect(await Bun.file(join(fixture.home, ".config/b")).exists()).toBe(false);
    expect(await Bun.file(join(fixture.checkout, "backups/stow-conflicts")).exists()).toBe(false);
  });

  test("replaces an identical live file without creating a backup", async () => {
    const fixture = await makeFixture({ ".config/example": "same\n" });
    const livePath = join(fixture.home, ".config/example");
    await mkdir(join(livePath, ".."), { recursive: true });
    await writeFile(livePath, "same\n");

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect((await lstat(livePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(join(fixture.checkout, "backups/stow-conflicts")).exists()).toBe(false);
  });

  test("does not remove tracked data through an already-stowed parent", async () => {
    const fixture = await makeFixture({ ".config/example/config.txt": "tracked\n" });
    await mkdir(join(fixture.home, ".config"), { recursive: true });
    await symlink(
      "../.dotfiles/home/.config/example",
      join(fixture.home, ".config/example"),
    );
    const trackedPath = join(fixture.checkout, "home/.config/example/config.txt");

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await readFile(trackedPath, "utf8")).toBe("tracked\n");
    expect(await readFile(join(fixture.home, ".config/example/config.txt"), "utf8")).toBe("tracked\n");
  });

  test("retains conflict backups when GNU Stow fails", async () => {
    const fixture = await makeFixture({ ".config/a": "tracked\n" });
    const conflict = join(fixture.home, ".config/a");
    await mkdir(join(conflict, ".."), { recursive: true });
    await writeFile(conflict, "live\n");
    const fakeBin = join(fixture.home, "fake-bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "stow"),
      '#!/bin/sh\n[ "${1:-}" = "--version" ] && exit 0\nexit 1\n',
    );
    await chmod(join(fakeBin, "stow"), 0o755);

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply", "--yes"],
      cwd: fixture.checkout,
      env: { ...fixture.env, PATH: `${fakeBin}:${fixture.env.PATH}` },
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("live-file backups remain at");
    const roots = await readdir(join(fixture.checkout, "backups/stow-conflicts"));
    expect(
      await readFile(
        join(fixture.checkout, "backups/stow-conflicts", roots[0]!, ".config/a"),
        "utf8",
      ),
    ).toBe("live\n");
  });

  test("leaves generated live artifacts untouched", async () => {
    const fixture = await makeFixture({
      ".pi/normal.txt": "tracked\n",
      ".pi/node_modules/pkg/index.js": "tracked generated\n",
      ".pi/cache.tsbuildinfo": "tracked generated\n",
    });
    const generated = join(fixture.home, ".pi/node_modules/pkg/index.js");
    await mkdir(join(generated, ".."), { recursive: true });
    await writeFile(generated, "live generated\n");

    const outcome = await createApplication({ checkoutRoot: fixture.checkout }).execute({
      argv: ["apply", "--yes"],
      cwd: fixture.checkout,
      env: fixture.env,
    });

    expect(outcome.exitCode).toBe(0);
    expect((await lstat(generated)).isSymbolicLink()).toBe(false);
    expect(await readFile(generated, "utf8")).toBe("live generated\n");
    expect((await lstat(join(fixture.home, ".pi/normal.txt"))).isSymbolicLink()).toBe(true);
  });
});
