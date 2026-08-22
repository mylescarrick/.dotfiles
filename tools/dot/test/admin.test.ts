import { describe, expect, test } from "bun:test";
import { hasAdminPrivileges, warnWithoutAdminPrivileges } from "../src/admin";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/process";
import type { Terminal } from "../src/terminal";

class ScriptedProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly results: ProcessResult[]) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.results.shift() ?? { exitCode: 0, stderr: "", stdout: "" };
  }
}

function capturingTerminal(interactive: boolean): Terminal & { written: string[] } {
  const written: string[] = [];
  return {
    interactive,
    async prompt() {
      throw new Error("unexpected prompt");
    },
    write(message) {
      written.push(message);
    },
    written,
  };
}

const options = { checkoutRoot: "/tmp/checkout", env: {} };

describe("admin privilege detection", () => {
  test("reads membership live rather than trusting the shell's cached groups", async () => {
    const processes = new ScriptedProcesses([
      { exitCode: 0, stderr: "", stdout: "carrickm\n" },
      { exitCode: 0, stderr: "", stdout: "yes carrickm is a member of admin\n" },
    ]);

    expect(await hasAdminPrivileges({ ...options, processes })).toBe(true);
    expect(processes.requests.map((request) => request.argv)).toEqual([
      ["id", "-un"],
      ["dseditgroup", "-o", "checkmember", "-m", "carrickm", "admin"],
    ]);
  });

  test("treats dseditgroup's non-member exit code as not elevated", async () => {
    const processes = new ScriptedProcesses([
      { exitCode: 0, stderr: "", stdout: "carrickm\n" },
      { exitCode: 67, stderr: "", stdout: "no carrickm is NOT a member of admin\n" },
    ]);

    expect(await hasAdminPrivileges({ ...options, processes })).toBe(false);
  });

  test("reports unknown rather than guessing when the user cannot be resolved", async () => {
    const processes = new ScriptedProcesses([{ exitCode: 1, stderr: "boom", stdout: "" }]);

    expect(await hasAdminPrivileges({ ...options, processes })).toBeUndefined();
    expect(processes.requests).toHaveLength(1);
  });
});

describe("admin privilege warning", () => {
  test("warns in red when elevation is missing", async () => {
    const processes = new ScriptedProcesses([
      { exitCode: 0, stderr: "", stdout: "carrickm\n" },
      { exitCode: 67, stderr: "", stdout: "" },
    ]);
    const terminal = capturingTerminal(true);

    await warnWithoutAdminPrivileges({ ...options, processes, terminal });

    expect(terminal.written).toHaveLength(1);
    expect(terminal.written[0]).toStartWith("\u001B[31m");
    expect(terminal.written[0]).toEndWith("\u001B[39m\n");
    expect(terminal.written[0]).toContain("not currently an admin");
  });

  test("omits colour codes when the terminal is not interactive", async () => {
    const processes = new ScriptedProcesses([
      { exitCode: 0, stderr: "", stdout: "carrickm\n" },
      { exitCode: 67, stderr: "", stdout: "" },
    ]);
    const terminal = capturingTerminal(false);

    await warnWithoutAdminPrivileges({ ...options, processes, terminal });

    expect(terminal.written[0]).not.toContain("\u001B");
    expect(terminal.written[0]).toContain("not currently an admin");
  });

  test("stays silent when already elevated", async () => {
    const processes = new ScriptedProcesses([
      { exitCode: 0, stderr: "", stdout: "carrickm\n" },
      { exitCode: 0, stderr: "", stdout: "" },
    ]);
    const terminal = capturingTerminal(true);

    await warnWithoutAdminPrivileges({ ...options, processes, terminal });

    expect(terminal.written).toEqual([]);
  });

  test("stays silent when privilege state cannot be determined", async () => {
    const processes = new ScriptedProcesses([{ exitCode: 1, stderr: "boom", stdout: "" }]);
    const terminal = capturingTerminal(true);

    await warnWithoutAdminPrivileges({ ...options, processes, terminal });

    expect(terminal.written).toEqual([]);
  });
});
