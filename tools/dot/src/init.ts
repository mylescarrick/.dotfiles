import { apply } from "./apply";
import { bootstrapMachine } from "./bootstrap";
import { runDoctor } from "./diagnostics";
import type { ProcessRunner } from "./process";
import type { Terminal } from "./terminal";

export async function initialize(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly knownBrewPaths?: readonly string[];
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const bootstrap = await bootstrapMachine(options);
  const applyOutput = await apply({
    acceptTracked: false,
    checkoutRoot: options.checkoutRoot,
    env: bootstrap.env,
    processes: options.processes,
    terminal: options.terminal,
  });
  const doctor = await runDoctor({
    checkoutRoot: options.checkoutRoot,
    env: bootstrap.env,
    processes: options.processes,
  });
  return {
    exitCode: doctor.healthy ? 0 : 1,
    stdout: `${bootstrap.stdout}${applyOutput}${doctor.stdout}`,
  };
}
