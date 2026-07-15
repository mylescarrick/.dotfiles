import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";
import { bunProcessRunner, type ProcessRequest, type ProcessRunner } from "../src/process";

const temporaryDirectories: string[] = [];

async function run(argv: string[], cwd: string): Promise<void> {
  const result = Bun.spawnSync(argv, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function fixture(): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "dot-skills-authoring-"));
  temporaryDirectories.push(checkout);
  for (const name of ["local", "vendored", "ignored"]) {
    await mkdir(join(checkout, "home/.agents/skills", name), { recursive: true });
    await writeFile(join(checkout, "home/.agents/skills", name, "SKILL.md"), `# ${name}\n`);
  }
  await mkdir(join(checkout, "home/.pi/agent/skills"), { recursive: true });
  await mkdir(join(checkout, "home/.claude/skills"), { recursive: true });
  await writeFile(join(checkout, ".gitignore"), "home/.agents/skills/ignored/\n");
  await writeFile(
    join(checkout, "home/.agents/.skill-lock.json"),
    '{"skills":{"vendored": {"source":"example"}}}\n',
  );
  await symlink("../../../.agents/skills/gone", join(checkout, "home/.pi/agent/skills/gone"));
  await run(["git", "init", "--initial-branch=main"], checkout);
  return checkout;
}

class RecordingProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  async run(request: ProcessRequest) {
    this.requests.push(request);
    return { exitCode: 1, stdout: "", stderr: "failed" };
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("skills authoring", () => {
  test("sync creates relative links, skips ignored skills, and prunes dangling links", async () => {
    const checkout = await fixture();
    const outcome = await createApplication({
      checkoutRoot: checkout,
      processes: bunProcessRunner,
    }).execute({ argv: ["skills", "sync"], cwd: checkout, env: process.env });

    expect(outcome).toMatchObject({ exitCode: 0 });
    expect(await readlink(join(checkout, "home/.pi/agent/skills/local"))).toBe(
      "../../../.agents/skills/local",
    );
    expect(await readlink(join(checkout, "home/.claude/skills/vendored"))).toBe(
      "../../.agents/skills/vendored",
    );
    expect(await Bun.file(join(checkout, "home/.pi/agent/skills/ignored")).exists()).toBe(false);
    await expect(lstat(join(checkout, "home/.pi/agent/skills/gone"))).rejects.toThrow();
  });

  test("list distinguishes vendored and local skills", async () => {
    const checkout = await fixture();
    const outcome = await createApplication({ checkoutRoot: checkout }).execute({
      argv: ["skills", "list"],
      cwd: checkout,
      env: {},
    });
    expect(outcome.stdout).toContain("local\tlocal\n");
    expect(outcome.stdout).toContain("vendored\tvendored\n");
  });

  test("add scopes the external CLI to the current checkout", async () => {
    const checkout = await fixture();
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["skills", "add", "owner/repo", "one", "two"],
      cwd: checkout,
      env: { HOME: "/real/home" },
    });

    expect(outcome.exitCode).toBe(1);
    const request = processes.requests[0]!;
    expect(request.argv).toEqual([
      "bunx",
      "skills@latest",
      "add",
      "owner/repo",
      "-g",
      "-y",
      "-s",
      "one",
      "two",
      "-a",
      "pi",
      "claude-code",
    ]);
    expect(request.env.HOME).toBe(join(checkout, "home"));
    expect(request.env.XDG_CONFIG_HOME).not.toContain("/real/home");
    expect(await Bun.file(request.env.XDG_CONFIG_HOME!).exists()).toBe(false);
  });

  test("remove deletes a local skill even when the external CLI has no lock entry", async () => {
    const checkout = await fixture();
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: checkout, processes }).execute({
      argv: ["skills", "remove", "local"],
      cwd: checkout,
      env: {},
    });

    expect(outcome.exitCode).toBe(0);
    expect(await Bun.file(join(checkout, "home/.agents/skills/local")).exists()).toBe(false);
    expect(await Bun.file(join(checkout, "home/.pi/agent/skills/local")).exists()).toBe(false);
  });

  test("rejects incomplete add before invoking external tooling", async () => {
    const processes = new RecordingProcesses();
    const outcome = await createApplication({ checkoutRoot: "/unused", processes }).execute({
      argv: ["skills", "add", "owner/repo"],
      cwd: "/unused",
      env: {},
    });
    expect(outcome.exitCode).toBe(2);
    expect(processes.requests).toHaveLength(0);
  });
});
