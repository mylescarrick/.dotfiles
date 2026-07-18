import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const launcherPath = resolve(import.meta.dir, "../../../dot");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function run(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

async function makeFixture(
  options: { withBun?: boolean; withGit?: boolean } = {},
): Promise<{
  checkout: string;
  env: Record<string, string>;
  fakeBin: string;
  home: string;
  invocationLog: string;
  launcherLink: string;
  origin: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dot-launcher-")));
  temporaryDirectories.push(root);

  const checkout = join(root, ".dotfiles");
  const fakeBin = join(root, "bin");
  const invocationLog = join(root, "bun-argv");
  const origin = join(root, "origin.git");
  await mkdir(join(checkout, "tools/dot/src"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(launcherPath, join(checkout, "dot"));
  await chmod(join(checkout, "dot"), 0o755);
  await writeFile(join(checkout, "tools/dot/src/main.ts"), "// fixture\n");
  if (options.withBun !== false) {
    await writeFile(
      join(fakeBin, "bun"),
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$DOT_TEST_INVOCATION_LOG\"\n[ -z \"${DOT_TEST_MAIN_CONTENT_LOG:-}\" ] || cat \"$1\" > \"$DOT_TEST_MAIN_CONTENT_LOG\"\nexit 0\n",
    );
    await chmod(join(fakeBin, "bun"), 0o755);
  }
  const launcherLink = join(fakeBin, "dot");
  await symlink("../.dotfiles/dot", launcherLink);

  if (options.withGit) {
    await run(["git", "init", "--bare", "--initial-branch=main", origin]);
    await run(["git", "init", "--initial-branch=main"], checkout);
    await run(["git", "config", "user.name", "Dot Tests"], checkout);
    await run(["git", "config", "user.email", "dot@example.test"], checkout);
    await run(["git", "add", "."], checkout);
    await run(["git", "commit", "-m", "initial"], checkout);
    await run(["git", "remote", "add", "origin", origin], checkout);
    await run(["git", "push", "-u", "origin", "main"], checkout);
  }

  return {
    checkout,
    fakeBin,
    home: root,
    invocationLog,
    launcherLink,
    origin,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      DOT_TEST_INVOCATION_LOG: invocationLog,
    },
  };
}

async function makePublisher(fixture: {
  home: string;
  origin: string;
}): Promise<string> {
  const publisher = join(fixture.home, `publisher-${crypto.randomUUID()}`);
  await run(["git", "clone", fixture.origin, publisher]);
  await run(["git", "config", "user.name", "Dot Publisher"], publisher);
  await run(["git", "config", "user.email", "publisher@example.test"], publisher);
  return publisher;
}

async function publishChange(fixture: {
  home: string;
  origin: string;
}): Promise<string> {
  const publisher = await makePublisher(fixture);
  await writeFile(join(publisher, "published.txt"), "new revision\n");
  await run(["git", "add", "published.txt"], publisher);
  await run(["git", "commit", "-m", "publish change"], publisher);
  await run(["git", "push", "origin", "main"], publisher);
  return run(["git", "rev-parse", "HEAD"], publisher);
}

async function publishApplicationChange(fixture: {
  home: string;
  origin: string;
}): Promise<string> {
  const publisher = await makePublisher(fixture);
  await writeFile(
    join(publisher, "tools/dot/src/main.ts"),
    "// refreshed Bun application\n",
  );
  await run(["git", "add", "tools/dot/src/main.ts"], publisher);
  await run(["git", "commit", "-m", "update application"], publisher);
  await run(["git", "push", "origin", "main"], publisher);
  return run(["git", "rev-parse", "HEAD"], publisher);
}

async function publishLauncherChange(fixture: {
  home: string;
  origin: string;
}): Promise<string> {
  const publisher = await makePublisher(fixture);
  await writeFile(
    join(publisher, "dot"),
    `#!/bin/sh
printf 'refreshed\\n' > "$DOT_TEST_REFRESH_LOG"
exec bun "$HOME/.dotfiles/tools/dot/src/main.ts" "$@"
`,
    { mode: 0o755 },
  );
  await run(["git", "add", "dot"], publisher);
  await run(["git", "commit", "-m", "update launcher"], publisher);
  await run(["git", "push", "origin", "main"], publisher);
  return run(["git", "rev-parse", "HEAD"], publisher);
}

describe("dot launcher", () => {
  test("runs the Bun application from its checkout and forwards arguments", async () => {
    const fixture = await makeFixture();
    const child = Bun.spawn([join(fixture.checkout, "dot"), "--version"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(await readFile(fixture.invocationLog, "utf8")).toBe(
      `${join(fixture.checkout, "tools/dot/src/main.ts")}\n--version\n`,
    );
  });

  test("resolves the checkout when invoked through a symlink", async () => {
    const fixture = await makeFixture();
    const child = Bun.spawn([fixture.launcherLink, "help"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect(await readFile(fixture.invocationLog, "utf8")).toBe(
      `${join(fixture.checkout, "tools/dot/src/main.ts")}\nhelp\n`,
    );
  });

  test("bootstraps Bun interactively for init before executing the application", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    const installer = join(fixture.home, "bun-installer.sh");
    const curlLog = join(fixture.home, "curl-url");
    const pathLog = join(fixture.home, "bootstrap-path");
    const bunInstall = join(fixture.home, "custom-bun");
    await writeFile(
      installer,
      `#!/bin/sh
[ -z "\${DOT_TEST_SECRET:-}" ] || exit 9
mkdir -p "$BUN_INSTALL/bin"
cat > "$BUN_INSTALL/bin/bun" <<'BUN'
#!/bin/sh
printf '%s\\n' "$@" > "${fixture.invocationLog}"
printf '%s\\n' "$PATH" > "${pathLog}"
BUN
chmod +x "$BUN_INSTALL/bin/bun"
`,
    );
    await writeFile(
      join(fixture.fakeBin, "curl"),
      `#!/bin/sh
printf '%s\\n' "$2" > "$DOT_TEST_CURL_LOG"
cp "$DOT_TEST_BUN_INSTALLER" "$4"
`,
    );
    await chmod(join(fixture.fakeBin, "curl"), 0o755);

    const child = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        '( sleep .2; printf "y\\n" ) | /usr/bin/script -q /dev/null "$DOT_TEST_LAUNCHER" init',
      ],
      {
        env: {
          ...fixture.env,
          BUN_INSTALL: bunInstall,
          DOT_TEST_BUN_INSTALLER: installer,
          DOT_TEST_CURL_LOG: curlLog,
          DOT_TEST_LAUNCHER: fixture.launcherLink,
          DOT_TEST_SECRET: "must-not-reach-installer",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);

    expect(stderr).toBe("");
    expect(stdout).toContain("Install it from https://bun.sh/install?");
    expect(await readFile(curlLog, "utf8")).toBe("https://bun.sh/install\n");
    expect(await readFile(pathLog, "utf8")).toStartWith(`${bunInstall}/bin:`);
    expect(await readFile(fixture.invocationLog, "utf8")).toBe(
      `${join(fixture.checkout, "tools/dot/src/main.ts")}\ninit\n`,
    );
  });

  test("refuses to bootstrap Bun from a checkout behind origin/main", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    await publishChange(fixture);
    await run(["git", "fetch", "origin", "main"], fixture.checkout);
    const curlLog = join(fixture.home, "unexpected-curl");
    await writeFile(
      join(fixture.fakeBin, "curl"),
      `#!/bin/sh\nprintf 'called\\n' > "${curlLog}"\nexit 9\n`,
    );
    await chmod(join(fixture.fakeBin, "curl"), 0o755);

    const child = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        '( sleep .2; printf "y\\n" ) | /usr/bin/script -q /dev/null "$DOT_TEST_LAUNCHER" init',
      ],
      {
        env: { ...fixture.env, DOT_TEST_LAUNCHER: fixture.launcherLink },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain(
      "dot: canonical checkout is not aligned with origin/main; refresh it before Bun bootstrap",
    );
    expect(await Bun.file(curlLog).exists()).toBe(false);
  });

  test("refuses to bootstrap Bun when canonical checkout is not on main", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    await run(["git", "checkout", "-b", "feature-init"], fixture.checkout);
    const child = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        '( sleep .2; printf "y\\n" ) | /usr/bin/script -q /dev/null "$DOT_TEST_LAUNCHER" init',
      ],
      {
        env: { ...fixture.env, DOT_TEST_LAUNCHER: fixture.launcherLink },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain(
      "dot: canonical checkout must be on main before Bun bootstrap (found 'feature-init')",
    );
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("refuses to bootstrap Bun from a noncanonical checkout", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    const worktree = join(fixture.home, "feature-init");
    await run(
      ["git", "worktree", "add", "-b", "feature-init", worktree],
      fixture.checkout,
    );

    const child = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        '( sleep .2; printf "y\\n" ) | /usr/bin/script -q /dev/null "$DOT_TEST_LAUNCHER" init',
      ],
      {
        env: { ...fixture.env, DOT_TEST_LAUNCHER: join(worktree, "dot") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain(
      `dot: init must run from the canonical checkout at ${fixture.checkout}`,
    );
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("does not download Bun when interactive bootstrap is declined", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    const child = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        '( sleep .2; printf "n\\n" ) | /usr/bin/script -q /dev/null "$DOT_TEST_LAUNCHER" init',
      ],
      {
        env: { ...fixture.env, DOT_TEST_LAUNCHER: fixture.launcherLink },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain("dot: Bun bootstrap cancelled");
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("refuses noninteractive init when Bun is unavailable", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    const child = Bun.spawn([fixture.launcherLink, "init"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("dot: Bun bootstrap requires an interactive terminal\n");
  });

  test("fails without changing anything when Bun is unavailable", async () => {
    const fixture = await makeFixture({ withBun: false });
    const child = Bun.spawn([fixture.launcherLink, "doctor"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dot: Bun is required; run 'dot init' to bootstrap it.\n",
    });
  });

  test("rejects update when its option appears before the command", async () => {
    const fixture = await makeFixture();
    const child = Bun.spawn([fixture.launcherLink, "--yes", "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toBe("dot: usage: dot update [--yes]\n");
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("rejects invalid update options before Bun checks or fetching", async () => {
    const fixture = await makeFixture({ withBun: false, withGit: true });
    const publishedHead = await publishChange(fixture);
    const head = await run(["git", "rev-parse", "HEAD"], fixture.checkout);

    const child = Bun.spawn([fixture.launcherLink, "update", "--force"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toBe("dot: usage: dot update [--yes]\n");
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(head);
    expect(head).not.toBe(publishedHead);
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("fast-forwards a clean canonical main before running update", async () => {
    const fixture = await makeFixture({ withGit: true });
    const publishedHead = await publishChange(fixture);
    const oldHead = await run(["git", "rev-parse", "HEAD"], fixture.checkout);
    expect(oldHead).not.toBe(publishedHead);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(
      publishedHead,
    );
    expect(await readFile(fixture.invocationLog, "utf8")).toBe(
      `${join(fixture.checkout, "tools/dot/src/main.ts")}\nupdate\n`,
    );
  });

  test("loads Bun application code from the fast-forwarded revision", async () => {
    const fixture = await makeFixture({ withGit: true });
    const contentLog = join(fixture.home, "main-content");
    const publishedHead = await publishApplicationChange(fixture);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: { ...fixture.env, DOT_TEST_MAIN_CONTENT_LOG: contentLog },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect(await readFile(contentLog, "utf8")).toBe("// refreshed Bun application\n");
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(
      publishedHead,
    );
  });

  test("re-executes launcher code from the fast-forwarded revision", async () => {
    const fixture = await makeFixture({ withGit: true });
    const refreshLog = join(fixture.home, "refresh-log");
    const publishedHead = await publishLauncherChange(fixture);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: { ...fixture.env, DOT_TEST_REFRESH_LOG: refreshLog },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
    expect(await readFile(refreshLog, "utf8")).toBe("refreshed\n");
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(
      publishedHead,
    );
  });

  test("refuses to update a dirty canonical checkout", async () => {
    const fixture = await makeFixture({ withGit: true });
    const head = await run(["git", "rev-parse", "HEAD"], fixture.checkout);
    await writeFile(join(fixture.checkout, "uncommitted.txt"), "local work\n");

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("dot: canonical checkout has uncommitted changes\n");
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(head);
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("refuses to update during an unfinished Git operation", async () => {
    const fixture = await makeFixture({ withGit: true });
    const head = await run(["git", "rev-parse", "HEAD"], fixture.checkout);
    await writeFile(join(fixture.checkout, ".git/MERGE_HEAD"), `${head}\n`);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe("dot: canonical checkout has an unfinished Git operation\n");
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("fails closed when Git cannot inspect checkout cleanliness", async () => {
    const fixture = await makeFixture({ withGit: true });
    await writeFile(join(fixture.checkout, ".git/index"), "not a git index\n");

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("dot: failed to inspect canonical checkout\n");
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("refuses to update canonical main when it is ahead of origin", async () => {
    const fixture = await makeFixture({ withGit: true });
    await writeFile(join(fixture.checkout, "local.txt"), "local commit\n");
    await run(["git", "add", "local.txt"], fixture.checkout);
    await run(["git", "commit", "-m", "local change"], fixture.checkout);
    const localHead = await run(["git", "rev-parse", "HEAD"], fixture.checkout);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "dot: canonical main is ahead of or diverged from origin/main\n",
    );
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(
      localHead,
    );
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("refuses to update diverged canonical and origin histories", async () => {
    const fixture = await makeFixture({ withGit: true });
    await publishChange(fixture);
    await writeFile(join(fixture.checkout, "local.txt"), "local commit\n");
    await run(["git", "add", "local.txt"], fixture.checkout);
    await run(["git", "commit", "-m", "local change"], fixture.checkout);
    const localHead = await run(["git", "rev-parse", "HEAD"], fixture.checkout);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "dot: canonical main is ahead of or diverged from origin/main\n",
    );
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(
      localHead,
    );
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("fails clearly when origin/main does not exist", async () => {
    const fixture = await makeFixture({ withGit: true });
    await run(
      ["git", "--git-dir", fixture.origin, "update-ref", "-d", "refs/heads/main"],
    );
    await run(
      ["git", "update-ref", "-d", "refs/remotes/origin/main"],
      fixture.checkout,
    );

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("dot: origin/main is unavailable after fetch\n");
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("stops before Bun execution when origin cannot be fetched", async () => {
    const fixture = await makeFixture({ withGit: true });
    const head = await run(["git", "rev-parse", "HEAD"], fixture.checkout);
    await rm(fixture.origin, { recursive: true });

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("dot: failed to fetch origin\n");
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(head);
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test("refuses to update from a noncanonical worktree", async () => {
    const fixture = await makeFixture({ withGit: true });
    const worktree = join(fixture.home, "feature-worktree");
    await run(
      ["git", "worktree", "add", "-b", "feature-worktree", worktree],
      fixture.checkout,
    );

    const child = Bun.spawn([join(worktree, "dot"), "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      `dot: update must run from the canonical checkout at ${fixture.checkout}\n`,
    );
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });

  test.each([
    {
      name: "another branch",
      prepare: (checkout: string) =>
        run(["git", "checkout", "-b", "feature"], checkout),
      expected:
        "dot: canonical checkout must be on main (found 'feature')\n",
    },
    {
      name: "detached HEAD",
      prepare: (checkout: string) =>
        run(["git", "checkout", "--detach"], checkout),
      expected:
        "dot: canonical checkout must be on main (found 'detached HEAD')\n",
    },
  ])("refuses to update from $name", async ({ prepare, expected }) => {
    const fixture = await makeFixture({ withGit: true });
    await prepare(fixture.checkout);
    const head = await run(["git", "rev-parse", "HEAD"], fixture.checkout);

    const child = Bun.spawn([fixture.launcherLink, "update"], {
      env: fixture.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toBe(expected);
    expect(await run(["git", "rev-parse", "HEAD"], fixture.checkout)).toBe(head);
    expect(await Bun.file(fixture.invocationLog).exists()).toBe(false);
  });
});
