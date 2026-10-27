import { describe, expect, test } from "bun:test";
import { bunProcessRunner } from "../src/process";

describe("process runner", () => {
  test("an inheriting child gets the terminal for input, so an agent can hear the user", async () => {
    const probe = `import { bunProcessRunner } from "${import.meta.dir}/../src/process";
const r = await bunProcessRunner.run({ argv: ["sh", "-c", "[ -t 0 ]"], cwd: "/tmp", env: process.env, output: "inherit" });
process.exit(r.exitCode);`;
    const dir = await Bun.$`mktemp -d`.text();
    const file = `${dir.trim()}/probe.ts`;
    await Bun.write(file, probe);

    // `script` gives the probe a real pseudo-terminal, which a test runner does not have.
    const child = Bun.spawn(["script", "-q", "/dev/null", process.execPath, file], {
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    expect(await child.exited).toBe(0);
  });

  test("a capturing child still gets no terminal", async () => {
    const result = await bunProcessRunner.run({
      argv: ["sh", "-c", "[ -t 0 ] && echo tty || echo none"],
      cwd: "/tmp",
      env: process.env,
    });
    expect(result.stdout.trim()).toBe("none");
  });
});
