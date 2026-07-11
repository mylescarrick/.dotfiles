export type ExecResult = {
  stdout?: string
  stderr?: string
  code?: number | null
  killed?: boolean
}

export type ExecOptions = {
  timeout?: number
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

export type HerdrAvailability =
  | { available: true; version: string; serverRunning: boolean; message: string }
  | { available: false; version?: string; serverRunning: false; message: string }

export type HerdrStartOptions = {
  name: string
  cwd: string
  argv: string[]
  split?: "right" | "down"
  focus?: boolean
  env?: Record<string, string>
}

export type HerdrWaitStatus = "idle" | "working" | "blocked" | "unknown"

const SERVER_START_LOG = "/tmp/pi-herdr-server.log"

function outputOf(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
}

function success(result: ExecResult): boolean {
  return result.code === 0 || result.code === undefined || result.code === null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class HerdrCli {
  constructor(private readonly exec: ExecFn) {}

  async availability(): Promise<HerdrAvailability> {
    const version = await this.runOptional(["--version"], { timeout: 3000 })
    if (!version.ok) {
      return {
        available: false,
        serverRunning: false,
        message: version.output || "herdr is not available on PATH",
      }
    }

    const list = await this.runOptional(["agent", "list"], { timeout: 3000 })
    return {
      available: true,
      version: version.output || "herdr available",
      serverRunning: list.ok,
      message: list.ok ? "herdr is available and the server is reachable" : `herdr is available but no server responded: ${list.output}`,
    }
  }

  async ensureServer(): Promise<{ ok: true; started: boolean; message: string } | { ok: false; message: string }> {
    const before = await this.runOptional(["agent", "list"], { timeout: 3000 })
    if (before.ok) return { ok: true, started: false, message: "Herdr server already reachable" }

    const start = await this.exec("sh", ["-lc", `nohup herdr server >${SERVER_START_LOG} 2>&1 &`], { timeout: 3000 })
    if (!success(start)) {
      return { ok: false, message: `Failed to start Herdr server: ${outputOf(start)}` }
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(250)
      const probe = await this.runOptional(["agent", "list"], { timeout: 3000 })
      if (probe.ok) {
        return { ok: true, started: true, message: `Started Herdr server (log: ${SERVER_START_LOG})` }
      }
    }

    return { ok: false, message: `Started Herdr server but it did not become reachable (log: ${SERVER_START_LOG})` }
  }

  async startAgent(options: HerdrStartOptions): Promise<{ ok: boolean; output: string; startedServer: boolean }> {
    const server = await this.ensureServer()
    if (!server.ok) return { ok: false, output: server.message, startedServer: false }

    const args = ["agent", "start", options.name, "--cwd", options.cwd, "--split", options.split ?? "right"]
    args.push(options.focus ? "--focus" : "--no-focus")

    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push("--env", `${key}=${value}`)
    }

    args.push("--", ...options.argv)
    const result = await this.runOptional(args, { timeout: 10_000 })
    const output = [server.message, result.output].filter(Boolean).join("\n")
    return { ok: result.ok, output, startedServer: server.started }
  }

  async readAgent(target: string, lines = 80): Promise<{ ok: boolean; output: string }> {
    return this.runOptional(["agent", "read", target, "--source", "recent", "--lines", String(lines), "--format", "text"], { timeout: 5000 })
  }

  async waitAgent(target: string, status: HerdrWaitStatus, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    return this.runOptional(["agent", "wait", target, "--status", status, "--timeout", String(timeoutMs)], { timeout: timeoutMs + 2000 })
  }

  async sendAgent(target: string, text: string): Promise<{ ok: boolean; output: string }> {
    return this.runOptional(["agent", "send", target, text], { timeout: 5000 })
  }

  async listAgents(): Promise<{ ok: boolean; output: string }> {
    return this.runOptional(["agent", "list"], { timeout: 5000 })
  }

  private async runOptional(args: string[], options?: ExecOptions): Promise<{ ok: boolean; output: string }> {
    try {
      const result = await this.exec("herdr", args, options)
      return { ok: success(result), output: outputOf(result) }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  }
}
