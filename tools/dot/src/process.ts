export interface ProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly output?: "capture" | "inherit";
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export const bunProcessRunner: ProcessRunner = {
  async run(request) {
    const child = Bun.spawn([...request.argv], {
      cwd: request.cwd,
      env: request.env,
      stdout: request.output === "inherit" ? "inherit" : "pipe",
      stderr: request.output === "inherit" ? "inherit" : "pipe",
    });

    if (request.output === "inherit") {
      return { exitCode: await child.exited, stdout: "", stderr: "" };
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  },
};
