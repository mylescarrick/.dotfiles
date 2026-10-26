import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployRecord } from "../src/deploy-record";
import { bunProcessRunner } from "../src/process";
import { applySkills, inspectSkills, restoreSkill } from "../src/skills";

const temporaryDirectories: string[] = [];

function run(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function commitUpstream(upstream: string, content: string): Promise<string> {
  await write(join(upstream, "skills/beta/SKILL.md"), content);
  run(["git", "add", "."], upstream);
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "beta"], upstream);
  return run(["git", "rev-parse", "HEAD:skills/beta"], upstream);
}

function lockEntry(upstream: string, hash: string) {
  return {
    skillFolderHash: hash,
    skillPath: "skills/beta/SKILL.md",
    source: "example/upstream",
    sourceType: "github",
    sourceUrl: upstream,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dot-skills-"));
  temporaryDirectories.push(root);
  const checkout = join(root, "dotfiles");
  const home = join(root, "home");
  const upstream = join(root, "upstream");
  await mkdir(home, { recursive: true });
  await mkdir(upstream, { recursive: true });
  run(["git", "init", "-q", "--initial-branch=main"], upstream);
  const betaHash = await commitUpstream(upstream, "# Beta v1\n");

  await write(join(checkout, "skills/local/alpha/SKILL.md"), "# Alpha\n");
  await write(
    join(checkout, "skills/lock.json"),
    JSON.stringify({ skills: { beta: lockEntry(upstream, betaHash) }, version: 1 })
  );
  await write(join(checkout, "skills/external.json"), JSON.stringify({ skills: ["ext"], version: 1 }));

  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const options = { checkoutRoot: checkout, env, home, processes: bunProcessRunner };
  return { betaHash, checkout, env, home, options, root, upstream };
}

async function driftKinds(options: Awaited<ReturnType<typeof fixture>>["options"]) {
  const { plan } = await inspectSkills({ ...options, network: true });
  return plan.drift.map((item) => `${item.kind}:${item.name}`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("skill copy deployment", () => {
  test("copies local and vendored skills as real directories with agent links", async () => {
    const { betaHash, env, home, options } = await fixture();

    expect(await applySkills(options)).toContain("2 installed, 0 updated, 0 removed");

    expect((await lstat(join(home, ".agents/skills/alpha"))).isDirectory()).toBe(true);
    expect(await readFile(join(home, ".agents/skills/beta/SKILL.md"), "utf8")).toBe("# Beta v1\n");
    expect(await readlink(join(home, ".pi/agent/skills/alpha"))).toBe("../../../.agents/skills/alpha");
    expect(await readlink(join(home, ".claude/skills/beta"))).toBe("../../.agents/skills/beta");
    const globalLock = JSON.parse(await readFile(join(home, ".agents/.skill-lock.json"), "utf8"));
    expect(globalLock.skills.beta.skillFolderHash).toBe(betaHash);
    expect(Object.keys((await readDeployRecord(env, home)).entries).sort()).toEqual([
      ".agents/skills/alpha",
      ".agents/skills/beta",
    ]);

    expect(await applySkills(options)).toContain("0 installed, 0 updated, 0 removed");
    expect(await driftKinds(options)).toEqual([]);
  });

  test("updates an untouched copy when the repo changes", async () => {
    const { checkout, home, options } = await fixture();
    await applySkills(options);
    await write(join(checkout, "skills/local/alpha/SKILL.md"), "# Alpha v2\n");

    expect(await applySkills(options)).toContain("0 installed, 1 updated");
    expect(await readFile(join(home, ".agents/skills/alpha/SKILL.md"), "utf8")).toBe("# Alpha v2\n");
  });

  test("keeps a local edit as drift until it is restored", async () => {
    const { checkout, home, options } = await fixture();
    await applySkills(options);
    await write(join(home, ".agents/skills/alpha/SKILL.md"), "# Alpha edited here\n");
    await write(join(checkout, "skills/local/alpha/NOTES.md"), "repo side\n");

    expect(await driftKinds(options)).toEqual(["conflict:alpha"]);
    await applySkills(options);
    expect(await readFile(join(home, ".agents/skills/alpha/SKILL.md"), "utf8")).toBe("# Alpha edited here\n");

    await restoreSkill({ ...options, name: "alpha" });
    expect(await readFile(join(home, ".agents/skills/alpha/SKILL.md"), "utf8")).toBe("# Alpha\n");
    expect(await driftKinds(options)).toEqual([]);
  });

  test("classifies skills CLI installs and updates through its global lock", async () => {
    const { home, options, upstream } = await fixture();
    await applySkills(options);

    const newHash = await commitUpstream(upstream, "# Beta v2\n");
    await write(join(home, ".agents/skills/beta/SKILL.md"), "# Beta v2\n");
    await write(join(home, ".agents/skills/gamma/SKILL.md"), "# Gamma\n");
    await write(join(home, ".agents/skills/delta/SKILL.md"), "# Delta\n");
    const lockPath = join(home, ".agents/.skill-lock.json");
    const globalLock = JSON.parse(await readFile(lockPath, "utf8"));
    globalLock.skills.beta = { ...globalLock.skills.beta, skillFolderHash: newHash };
    globalLock.skills.gamma = lockEntry(upstream, "0000");
    await writeFile(lockPath, JSON.stringify(globalLock));

    expect(await driftKinds(options)).toEqual([
      "vendored-updated:beta",
      "added-locally:delta",
      "vendored-added:gamma",
    ]);
  });

  test("links external skills without reporting them", async () => {
    const { home, options } = await fixture();
    await write(join(home, ".agents/skills/ext/SKILL.md"), "# External\n");

    await applySkills(options);
    expect(await readlink(join(home, ".pi/agent/skills/ext"))).toBe("../../../.agents/skills/ext");
    expect(await driftKinds(options)).toEqual([]);
  });

  test("migrates old stow links into the checkout", async () => {
    const { checkout, home, options } = await fixture();
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    await mkdir(join(home, ".pi/agent/skills"), { recursive: true });
    await symlink(join(checkout, "home/.agents/skills/alpha"), join(home, ".agents/skills/alpha"));
    await symlink(join(checkout, "home/.agents/.skill-lock.json"), join(home, ".agents/.skill-lock.json"));
    await symlink(join(checkout, "home/.pi/agent/skills/alpha"), join(home, ".pi/agent/skills/alpha"));
    await symlink(join(checkout, "home/.pi/agent/skills/gone"), join(home, ".pi/agent/skills/gone"));

    await applySkills(options);

    expect((await lstat(join(home, ".agents/skills/alpha"))).isDirectory()).toBe(true);
    expect((await lstat(join(home, ".agents/.skill-lock.json"))).isFile()).toBe(true);
    expect(await readlink(join(home, ".pi/agent/skills/alpha"))).toBe("../../../.agents/skills/alpha");
    expect(await lstat(join(home, ".pi/agent/skills/gone")).catch(() => undefined)).toBeUndefined();
  });

  test("removes a skill the repo dropped only when it was untouched", async () => {
    const { checkout, home, options } = await fixture();
    await write(join(checkout, "skills/local/omega/SKILL.md"), "# Omega\n");
    await applySkills(options);
    await rm(join(checkout, "skills/local/alpha"), { recursive: true });
    await rm(join(checkout, "skills/local/omega"), { recursive: true });
    await write(join(home, ".agents/skills/omega/SKILL.md"), "# Omega edited\n");

    expect(await applySkills(options)).toContain("1 removed");
    expect(await lstat(join(home, ".agents/skills/alpha")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(home, ".pi/agent/skills/alpha")).catch(() => undefined)).toBeUndefined();
    expect(await driftKinds(options)).toEqual(["conflict:omega"]);
  });

  test("refuses to write through a directory stow folded into the checkout", async () => {
    const { checkout, home, options } = await fixture();
    await mkdir(join(checkout, "home/.claude"), { recursive: true });
    await symlink(join(checkout, "home/.claude"), join(home, ".claude"));

    await expect(applySkills(options)).rejects.toThrow("~/.claude/skills resolves into the checkout");
  });
});
