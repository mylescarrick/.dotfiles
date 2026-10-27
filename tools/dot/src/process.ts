export interface ProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly output?: "capture" | "inherit";
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProcessRunner {
  run: (request: ProcessRequest) => Promise<ProcessResult>;
}

export const bunProcessRunner: ProcessRunner = {
  async run(request) {
    const child = Bun.spawn([...request.argv], {
      cwd: request.cwd,
      env: request.env,
      stderr: request.output === "inherit" ? "inherit" : "pipe",
      // Bun gives a child no stdin by default. An interactive child (the reconcile agent, a
      // sudo prompt from brew) needs the terminal or it cannot hear the user.
      stdin: request.output === "inherit" ? "inherit" : undefined,
      stdout: request.output === "inherit" ? "inherit" : "pipe",
    });

    if (request.output === "inherit") {
      return { exitCode: await child.exited, stderr: "", stdout: "" };
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
  },
};
