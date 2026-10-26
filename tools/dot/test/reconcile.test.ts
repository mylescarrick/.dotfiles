import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployRecord } from "../src/deploy-record";
import { bunProcessRunner, type ProcessRequest, type ProcessRunner } from "../src/process";
import { reconcile } from "../src/reconcile";
import { applySkills } from "../src/skills";
import type { Terminal } from "../src/terminal";

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

const commit = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dot-reconcile-"));
  temporaryDirectories.push(root);
  const origin = join(root, "origin.git");
  const checkout = join(root, "dotfiles");
  const home = join(root, "home");
  run(["git", "init", "-q", "--bare", "--initial-branch=main", origin], root);
  run(["git", "clone", "-q", origin, checkout], root);
  await write(join(checkout, "skills/local/alpha/SKILL.md"), "# Alpha\n");
  await write(join(checkout, "README.md"), "dotfiles\n");
  run(["git", "add", "."], checkout);
  run([...commit, "init"], checkout);
  run(["git", "push", "-q", "origin", "main"], checkout);

  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  };
  await mkdir(home, { recursive: true });
  await applySkills({ checkoutRoot: checkout, env, home, processes: bunProcessRunner });
  await write(join(home, ".agents/skills/gamma/SKILL.md"), "# Gamma\n");
  return { checkout, env, home, origin, root };
}

/** Real git; scripted stand-ins for the agent and GitHub. */
function runner(agent: (cwd: string) => void, calls: string[]): ProcessRunner {
  return {
    run(request: ProcessRequest) {
      const [command] = request.argv;
      if (command === "pi") {
        calls.push("pi");
        agent(request.cwd);
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      }
      if (command === "gh") {
        calls.push("gh");
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "https://example.test/pr/1\n" });
      }
      if (command === "gitleaks") return Promise.reject(new Error("not installed"));
      return bunProcessRunner.run(request);
    },
  };
}

function terminal(answers: string[]): Terminal {
  return { interactive: true, prompt: () => Promise.resolve(answers.shift() ?? ""), write: () => undefined };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("dot reconcile", () => {
  test("absorbs agent commits into a pushed branch and stops asking", async () => {
    const { checkout, env, home, origin } = await fixture();
    const calls: string[] = [];
    const absorb = (cwd: string) => {
      run(["mkdir", "-p", "skills/local/gamma"], cwd);
      run(["cp", join(home, ".agents/skills/gamma/SKILL.md"), "skills/local/gamma/SKILL.md"], cwd);
      run(["git", "add", "."], cwd);
      run([...commit, "chore(skills): absorb gamma"], cwd);
    };

    const output = await reconcile({
      checkoutRoot: checkout,
      env,
      processes: runner(absorb, calls),
      terminal: terminal(["y"]),
    });

    expect(output).toContain("Opened https://example.test/pr/1");
    expect(calls).toEqual(["pi", "gh"]);
    expect(run(["git", "branch", "--list", "reconcile/*"], origin)).toMatch(/reconcile\//);
    expect(run(["git", "status", "--porcelain"], checkout)).toBe("");
    expect(Object.keys((await readDeployRecord(env, home)).handled)).toHaveLength(1);
    expect(
      await reconcile({ checkoutRoot: checkout, env, processes: runner(absorb, []), terminal: terminal([]) })
    ).toBe("No drift to reconcile\n");
  });

  test("refuses to push commits outside the allowlist", async () => {
    const { checkout, env, origin } = await fixture();
    const calls: string[] = [];
    const stray = (cwd: string) => {
      run(["sh", "-c", "echo hacked >> README.md"], cwd);
      run(["git", "add", "."], cwd);
      run([...commit, "oops"], cwd);
    };

    await expect(
      reconcile({ checkoutRoot: checkout, env, processes: runner(stray, calls), terminal: terminal(["y"]) })
    ).rejects.toThrow("outside skills/");
    expect(calls).toEqual(["pi"]);
    expect(run(["git", "branch", "--list", "reconcile/*"], origin)).toBe("");
  });

  test("offers to snooze when the agent commits nothing", async () => {
    const { checkout, env, root } = await fixture();
    const output = await reconcile({
      checkoutRoot: checkout,
      env,
      processes: runner(() => undefined, []),
      terminal: terminal(["y", "y"]),
    });

    expect(output).toContain("Snoozed 1 drift item(s)");
    expect(run(["git", "worktree", "list"], checkout).split("\n")).toHaveLength(1);
    const report = JSON.parse(await readFile(join(root, "state/dot/drift-report.json"), "utf8"));
    expect(report.items.map((item: { name: string }) => item.name)).toEqual(["gamma"]);
  });

  test("only summarises drift when not attached to a terminal", async () => {
    const { checkout, env } = await fixture();
    const output = await reconcile({
      checkoutRoot: checkout,
      env,
      processes: runner(() => undefined, []),
      terminal: { ...terminal([]), interactive: false },
    });
    expect(output).toContain("added-locally    gamma");
  });
});
