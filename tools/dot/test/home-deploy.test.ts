import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployRecord } from "../src/deploy-record";
import { deployHome, inspectHome, restoreFile } from "../src/home-deploy";
import { bunProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function git(cwd: string, ...argv: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...argv], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function write(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  if (mode) await chmod(path, mode);
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

async function fixture(
  tracked: Record<string, string> = { ".config/git/config": "[user]\n", ".zshrc": "export A=1\n" }
) {
  const root = await mkdtemp(join(tmpdir(), "dot-home-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "dotfiles");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  git(root, "init", "-q", "--initial-branch=main", checkout);
  for (const [rel, content] of Object.entries(tracked)) await write(join(checkout, "home", rel), content);
  await write(
    join(checkout, ".gitignore"),
    "home/.config/herdr/session.json\nhome/.oh-my-zsh/custom/secrets.zsh\n"
  );
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "init");
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(root, "state") };
  const options = { checkoutRoot: checkout, env, home, processes: bunProcessRunner };
  return { checkout, env, home, options, root };
}

const deploy = (options: Awaited<ReturnType<typeof fixture>>["options"], acceptTracked = false) =>
  deployHome({ ...options, acceptTracked });

describe("copy deployment of home/", () => {
  test("installs tracked files as real files, keeping the executable bit and a private .ssh", async () => {
    const { checkout, home, options } = await fixture({
      ".local/bin/tool": "#!/bin/sh\n",
      ".ssh/allowed_signers": "key\n",
    });
    await chmod(join(checkout, "home/.local/bin/tool"), 0o755);
    git(checkout, "add", ".");
    git(checkout, "commit", "-qm", "exec");

    expect(await deploy(options)).toContain("(2 installed, 0 updated, 0 link(s) replaced, 0 removed)");

    expect((await lstat(join(home, ".local/bin/tool"))).isSymbolicLink()).toBe(false);
    expect((await stat(join(home, ".local/bin/tool"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
    expect(await deploy(options)).toContain("(0 installed, 0 updated, 0 link(s) replaced, 0 removed)");
  });

  test("updates an untouched copy when the repo changes, but keeps a local edit as drift", async () => {
    const { checkout, home, options } = await fixture();
    await deploy(options);
    await write(join(checkout, "home/.zshrc"), "export A=2\n");
    await write(join(home, ".config/git/config"), "[user]\nname = me\n");
    await write(join(checkout, "home/.config/git/config"), "[user]\nname = repo\n");

    const output = await deploy(options);

    expect(output).toContain("1 updated");
    expect(output).toContain("1 file(s) differ from the repo and were kept; run 'dot reconcile'");
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("export A=2\n");
    expect(await readFile(join(home, ".config/git/config"), "utf8")).toBe("[user]\nname = me\n");
    expect((await inspectHome(options)).drift.map((item) => `${item.kind}:${item.name}`)).toEqual([
      "conflict:.config/git/config",
    ]);
  });

  test("a plain local edit is modified-locally, and restore puts the repo version back with a backup", async () => {
    const { home, options } = await fixture();
    await deploy(options);
    await write(join(home, ".zshrc"), "export A=mine\n");

    const drift = (await inspectHome(options)).drift;
    expect(drift.map((item) => `${item.kind}:${item.name}`)).toEqual(["modified-locally:.zshrc"]);

    const output = await restoreFile({ ...options, name: ".zshrc" });
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("export A=1\n");
    expect(output).toContain("previous copy kept at");
    const backups = join(options.env.XDG_STATE_HOME, "dot/backups");
    const [stamp] = await readdir(backups);
    expect(await readFile(join(backups, stamp as string, ".zshrc"), "utf8")).toBe("export A=mine\n");
    expect((await inspectHome(options)).drift).toEqual([]);
  });

  test("accepting tracked state backs up a first-run conflict before replacing it", async () => {
    const { home, options } = await fixture();
    await write(join(home, ".zshrc"), "export A=default\n");

    expect(await deploy(options)).toContain("1 file(s) differ from the repo and were kept");
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("export A=default\n");

    const output = await deploy(options, true);
    expect(output).toContain("1 file(s) backed up to");
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("export A=1\n");
  });

  test("removes a file the repo dropped only when the Mac's copy is untouched", async () => {
    const { checkout, home, options } = await fixture();
    await deploy(options);
    git(checkout, "rm", "-q", "home/.zshrc", "home/.config/git/config");
    git(checkout, "commit", "-qm", "drop");
    await write(join(home, ".config/git/config"), "[user]\nname = mine\n");

    const output = await deploy(options);

    expect(output).toContain("1 removed");
    expect(await exists(join(home, ".zshrc"))).toBe(false);
    expect(await readFile(join(home, ".config/git/config"), "utf8")).toBe("[user]\nname = mine\n");
    expect((await inspectHome(options)).drift.map((item) => item.name)).toEqual([".config/git/config"]);
  });
});

describe("first-run migration from stow", () => {
  test("replaces a file link into the checkout with a real copy of the same content", async () => {
    const { checkout, home, options } = await fixture();
    await symlink(join(checkout, "home/.zshrc"), join(home, ".zshrc"));

    expect(await deploy(options)).toContain("1 link(s) replaced");

    expect((await lstat(join(home, ".zshrc"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("export A=1\n");
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  test("unfolds a linked directory, keeping this Mac's runtime files and leaving the checkout clean", async () => {
    const { checkout, home, options } = await fixture({ ".config/herdr/config.toml": "a = 1\n" });
    await write(join(checkout, "home/.config/herdr/session.json"), '{"live":true}\n');
    await mkdir(join(home, ".config"), { recursive: true });
    await symlink(join(checkout, "home/.config/herdr"), join(home, ".config/herdr"));

    const output = await deploy(options);

    expect(output).toContain("1 link(s) replaced");
    expect((await lstat(join(home, ".config/herdr"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, ".config/herdr/config.toml"), "utf8")).toBe("a = 1\n");
    expect(await readFile(join(home, ".config/herdr/session.json"), "utf8")).toBe('{"live":true}\n');
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(await readFile(join(checkout, "home/.config/herdr/config.toml"), "utf8")).toBe("a = 1\n");
    expect((await inspectHome(options)).drift).toEqual([]);
  });

  test("moves an ignored file or folder that only this Mac has out of the checkout, into ~", async () => {
    const { checkout, home, options } = await fixture();
    await write(join(checkout, "home/.oh-my-zsh/custom/secrets.zsh"), "export TOKEN=x\n");
    await mkdir(join(home, ".oh-my-zsh/custom"), { recursive: true });
    await symlink(
      join(checkout, "home/.oh-my-zsh/custom/secrets.zsh"),
      join(home, ".oh-my-zsh/custom/secrets.zsh")
    );

    await deploy(options);

    const moved = join(home, ".oh-my-zsh/custom/secrets.zsh");
    expect((await lstat(moved)).isSymbolicLink()).toBe(false);
    expect(await readFile(moved, "utf8")).toBe("export TOKEN=x\n");
    expect(await exists(join(checkout, "home/.oh-my-zsh/custom/secrets.zsh"))).toBe(false);
  });

  test("refuses to write through a link that leaves the checkout", async () => {
    const { home, options, root } = await fixture();
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(home, ".config"));

    await expect(deploy(options)).rejects.toThrow("~/.config is a link outside the checkout");
  });
});

describe("recording what was deployed", () => {
  test("keeps a hash per file so later runs can tell a repo change from a local one", async () => {
    const { env, home, options } = await fixture();
    await deploy(options);

    const record = await readDeployRecord(env, home);
    expect(Object.keys(record.entries).sort()).toEqual([".config/git/config", ".zshrc"]);
  });
});
