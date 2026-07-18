import { describe, expect, test } from "bun:test";
import { application } from "../src/application";

const dotRoot = `${import.meta.dir}/..`;

describe("Bun entry point", () => {
  test("writes application output and returns its exit code", async () => {
    const expected = await application.execute({
      argv: [],
      cwd: dotRoot,
      env: process.env,
    });
    const child = Bun.spawn([process.execPath, "src/main.ts"], {
      cwd: dotRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ exitCode, stdout, stderr }).toEqual(expected);
  });
});
