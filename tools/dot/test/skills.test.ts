import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bunProcessRunner } from "../src/process";
import { validateSkillLinks } from "../src/skills";

const temporaryDirectories: string[] = [];

async function run(argv: string[], cwd: string): Promise<void> {
  const result = Bun.spawnSync(argv, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function fixture(options: { pi?: boolean; claude?: boolean } = {}): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), "dot-skills-"));
  temporaryDirectories.push(checkout);
  await mkdir(join(checkout, "home/.agents/skills/example"), { recursive: true });
  await writeFile(join(checkout, "home/.agents/skills/example/SKILL.md"), "# Example\n");
  await mkdir(join(checkout, "home/.pi/agent/skills"), { recursive: true });
  await mkdir(join(checkout, "home/.claude/skills"), { recursive: true });
  if (options.pi !== false) {
    await symlink(
      "../../../.agents/skills/example",
      join(checkout, "home/.pi/agent/skills/example"),
    );
  }
  if (options.claude !== false) {
    await symlink(
      "../../.agents/skills/example",
      join(checkout, "home/.claude/skills/example"),
    );
  }
  await run(["git", "init", "--initial-branch=main"], checkout);
  await run(["git", "add", "."], checkout);
  return checkout;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("tracked skill links", () => {
  test("the repository's tracked links are internally consistent", async () => {
    const checkout = resolve(import.meta.dir, "../../..");
    expect(
      await validateSkillLinks({ checkoutRoot: checkout, env: process.env, processes: bunProcessRunner }),
    ).toMatch(/^Skill links valid \([1-9][0-9]*\)\n$/);
  });

  test("accepts exact relative Pi and Claude links", async () => {
    const checkout = await fixture();
    expect(
      await validateSkillLinks({ checkoutRoot: checkout, env: process.env, processes: bunProcessRunner }),
    ).toBe("Skill links valid (1)\n");
  });

  test("reports a missing link without creating it", async () => {
    const checkout = await fixture({ claude: false });
    const missing = join(checkout, "home/.claude/skills/example");

    await expect(
      validateSkillLinks({ checkoutRoot: checkout, env: process.env, processes: bunProcessRunner }),
    ).rejects.toThrow(`tracked skill link is missing: ${missing}`);
    expect(await Bun.file(missing).exists()).toBe(false);
  });

  test("reports an extra dangling managed link", async () => {
    const checkout = await fixture();
    const dangling = join(checkout, "home/.pi/agent/skills/gone");
    await symlink("../../../.agents/skills/gone", dangling);

    await expect(
      validateSkillLinks({ checkoutRoot: checkout, env: process.env, processes: bunProcessRunner }),
    ).rejects.toThrow(`tracked skill link is dangling: ${dangling}`);
  });

  test("preserves a real file at a required link path", async () => {
    const checkout = await fixture({ pi: false });
    const collision = join(checkout, "home/.pi/agent/skills/example");
    await writeFile(collision, "local data\n");

    await expect(
      validateSkillLinks({ checkoutRoot: checkout, env: process.env, processes: bunProcessRunner }),
    ).rejects.toThrow("tracked skill path is not a symlink");
    expect(await readFile(collision, "utf8")).toBe("local data\n");
  });
});
