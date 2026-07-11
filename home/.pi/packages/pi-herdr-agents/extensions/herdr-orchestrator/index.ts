import { Type, type Static } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { HerdrCli, type HerdrWaitStatus } from "./herdr-cli.ts"
import { resolveModelFamilyTarget } from "./model-family.ts"
import {
  buildWorkerPrompt,
  defaultAgentName,
  HERDR_ROLES,
  isHerdrRole,
  ROLE_DEFAULT_TOOLS,
  ROLE_TO_MODEL_ROLE,
  slugifyAgentName,
  type HerdrRole,
} from "./prompts.ts"
import { truncateForTool } from "./truncate.ts"

const STATUS_VALUES = ["idle", "working", "blocked", "unknown"] as const
const WAIT_STATUS_VALUES = ["idle", "working", "blocked", "unknown"] as const

type StartOptions = {
  role: HerdrRole
  prompt: string
  name?: string
  family?: string
  cwd?: string
  writable?: boolean
  focus?: boolean
}

const availableSchema = Type.Object({})
const startSchema = Type.Object({
  role: StringEnum(HERDR_ROLES),
  prompt: Type.String({ description: "Task prompt to send to the child Pi agent" }),
  name: Type.Optional(Type.String({ description: "Stable Herdr agent name" })),
  family: Type.Optional(Type.String({ description: "Optional model family name" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child agent" })),
  writable: Type.Optional(Type.Boolean({ description: "Allow normal write-capable Pi tools. Requires explicit user approval." })),
  focus: Type.Optional(Type.Boolean({ description: "Focus the new Herdr agent pane" })),
})
const readSchema = Type.Object({
  target: Type.String(),
  lines: Type.Optional(Type.Number()),
})
const waitSchema = Type.Object({
  target: Type.String(),
  status: Type.Optional(StringEnum(WAIT_STATUS_VALUES)),
  timeoutMs: Type.Optional(Type.Number()),
})
const sendSchema = Type.Object({
  target: Type.String(),
  text: Type.String(),
})

type StartParams = Static<typeof startSchema>
type ReadParams = Static<typeof readSchema>
type WaitParams = Static<typeof waitSchema>
type SendParams = Static<typeof sendSchema>

function isProjectTrusted(ctx: ExtensionContext): boolean {
  return (ctx as ExtensionContext & { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false
}

function createHerdr(pi: ExtensionAPI): HerdrCli {
  return new HerdrCli((command, args, options) => pi.exec(command, args, options))
}

function splitCommandArgs(args: string): { head: string; prompt: string } {
  const delimiter = args.indexOf(" -- ")
  if (delimiter === -1) return { head: args.trim(), prompt: "" }
  return { head: args.slice(0, delimiter).trim(), prompt: args.slice(delimiter + 4).trim() }
}

function parseStartCommand(args: string, ctx: ExtensionContext): StartOptions | { error: string } {
  const { head, prompt } = splitCommandArgs(args)
  const tokens = head.split(/\s+/).filter(Boolean)
  const first = tokens.shift()
  if (!first || !isHerdrRole(first)) {
    return { error: `Usage: /herdr-start <${HERDR_ROLES.join("|")}> [--name name] [--family family] [--cwd path] [--write] -- <prompt>` }
  }

  const options: StartOptions = { role: first, prompt, cwd: ctx.cwd }
  while (tokens.length > 0) {
    const token = tokens.shift()
    if (token === "--name") options.name = tokens.shift()
    else if (token === "--family") options.family = tokens.shift()
    else if (token === "--cwd") options.cwd = tokens.shift()
    else if (token === "--write") options.writable = true
    else if (token === "--focus") options.focus = true
    else return { error: `Unknown /herdr-start option: ${token}` }
  }

  if (!prompt) return { error: "Usage: /herdr-start requires a prompt after --" }
  return options
}

function parseReadCommand(args: string): ReadParams | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const target = tokens.shift()
  if (!target) return { error: "Usage: /herdr-read <agent-name-or-id> [--lines N]" }
  let lines: number | undefined
  while (tokens.length > 0) {
    const token = tokens.shift()
    if (token === "--lines") {
      const parsed = Number(tokens.shift())
      if (Number.isFinite(parsed)) lines = parsed
    } else return { error: `Unknown /herdr-read option: ${token}` }
  }
  return { target, lines }
}

function parseWaitCommand(args: string): WaitParams | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const target = tokens.shift()
  if (!target) return { error: "Usage: /herdr-wait <agent-name-or-id> [--state idle|working|blocked|unknown] [--timeout-ms N]" }
  let status: HerdrWaitStatus | undefined
  let timeoutMs: number | undefined
  while (tokens.length > 0) {
    const token = tokens.shift()
    if (token === "--state") {
      const value = tokens.shift()
      if (value && (STATUS_VALUES as readonly string[]).includes(value)) status = value as HerdrWaitStatus
    } else if (token === "--timeout-ms") {
      const parsed = Number(tokens.shift())
      if (Number.isFinite(parsed)) timeoutMs = parsed
    } else return { error: `Unknown /herdr-wait option: ${token}` }
  }
  return { target, status, timeoutMs }
}

function parseSendCommand(args: string): SendParams | { error: string } {
  const { head, prompt } = splitCommandArgs(args)
  const target = head.trim()
  if (!target || !prompt) return { error: "Usage: /herdr-send <agent-name-or-id> -- <text>" }
  return { target, text: prompt }
}

function buildPiArgv(options: StartOptions, ctx: ExtensionContext): string[] {
  const cwd = options.cwd ?? ctx.cwd
  const name = slugifyAgentName(options.name ?? defaultAgentName(options.role))
  const modelRole = ROLE_TO_MODEL_ROLE[options.role]
  const modelTarget = resolveModelFamilyTarget({
    cwd,
    projectTrusted: isProjectTrusted(ctx),
    family: options.family,
    role: modelRole,
  })
  const writable = options.writable === true
  const prompt = buildWorkerPrompt({ role: options.role, parentPrompt: options.prompt, writable, cwd })
  const argv = ["pi", "--name", name]

  if (modelTarget) {
    argv.push("--provider", modelTarget.provider, "--model", modelTarget.model)
    if (modelTarget.thinkingLevel) argv.push("--thinking", modelTarget.thinkingLevel)
  }

  const tools = writable ? undefined : ROLE_DEFAULT_TOOLS[options.role]
  if (tools && tools.length > 0) argv.push("--tools", tools.join(","))

  argv.push(prompt)
  return argv
}

async function startAgent(pi: ExtensionAPI, params: StartOptions, ctx: ExtensionContext): Promise<{ ok: boolean; name: string; output: string }> {
  const herdr = createHerdr(pi)
  const cwd = params.cwd ?? ctx.cwd
  const name = slugifyAgentName(params.name ?? defaultAgentName(params.role))
  const argv = buildPiArgv({ ...params, name, cwd }, ctx)
  const result = await herdr.startAgent({
    name,
    cwd,
    argv,
    split: "right",
    focus: params.focus ?? false,
    env: {
      PI_HERDR_CHILD: "1",
      PI_HERDR_ROLE: params.role,
    },
  })
  return { ok: result.ok, name, output: result.output }
}

function toolText(text: string) {
  const truncated = truncateForTool(text)
  return {
    content: [{ type: "text" as const, text: truncated.text }],
    details: truncated,
  }
}

export default function herdrOrchestrator(pi: ExtensionAPI) {
  pi.registerCommand("herdr-status", {
    description: "Show Herdr availability and currently known agents",
    handler: async (_args, ctx) => {
      const herdr = createHerdr(pi)
      const availability = await herdr.availability()
      const agents = availability.available && availability.serverRunning ? await herdr.listAgents() : undefined
      ctx.ui.notify([availability.message, agents?.output].filter(Boolean).join("\n"), availability.available ? "info" : "warning")
    },
  })

  pi.registerCommand("herdr-start", {
    description: "Start a visible Herdr-managed Pi worker: /herdr-start <role> [opts] -- <prompt>",
    getArgumentCompletions: (prefix) => {
      if (prefix.includes(" ")) return null
      const items = HERDR_ROLES.filter((role) => role.startsWith(prefix)).map((role) => ({ value: role, label: role }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      const parsed = parseStartCommand(args, ctx)
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning")
        return
      }
      const result = await startAgent(pi, parsed, ctx)
      ctx.ui.notify(`${result.ok ? "Started" : "Failed to start"} Herdr agent ${result.name}\n${result.output}`, result.ok ? "info" : "error")
    },
  })

  pi.registerCommand("herdr-read", {
    description: "Read recent output from a Herdr agent",
    handler: async (args, ctx) => {
      const parsed = parseReadCommand(args)
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning")
        return
      }
      const result = await createHerdr(pi).readAgent(parsed.target, parsed.lines ?? 80)
      ctx.ui.notify(truncateForTool(result.output).text, result.ok ? "info" : "warning")
    },
  })

  pi.registerCommand("herdr-wait", {
    description: "Wait for a Herdr agent to reach a state",
    handler: async (args, ctx) => {
      const parsed = parseWaitCommand(args)
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning")
        return
      }
      const result = await createHerdr(pi).waitAgent(parsed.target, parsed.status ?? "idle", parsed.timeoutMs ?? 120_000)
      ctx.ui.notify(result.output || `${parsed.target} reached ${parsed.status ?? "idle"}`, result.ok ? "info" : "warning")
    },
  })

  pi.registerCommand("herdr-send", {
    description: "Send literal text to a Herdr agent",
    handler: async (args, ctx) => {
      const parsed = parseSendCommand(args)
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning")
        return
      }
      const result = await createHerdr(pi).sendAgent(parsed.target, parsed.text)
      ctx.ui.notify(result.output || `Sent text to ${parsed.target}`, result.ok ? "info" : "warning")
    },
  })

  pi.registerTool({
    name: "herdr_available",
    label: "Herdr Available",
    description: "Check whether Herdr is installed and whether the Herdr server is reachable.",
    parameters: availableSchema,
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const availability = await createHerdr(pi).availability()
      return toolText(JSON.stringify(availability, null, 2))
    },
  })

  pi.registerTool({
    name: "herdr_start_agent",
    label: "Start Herdr Agent",
    description: "Start a visible Herdr-managed Pi worker agent. Use only after applying the herdr-agents skill policy.",
    parameters: startSchema,
    async execute(_id, params: StartParams, _signal, _onUpdate, ctx) {
      const result = await startAgent(pi, params as StartOptions, ctx)
      return toolText(JSON.stringify(result, null, 2))
    },
  })

  pi.registerTool({
    name: "herdr_read_agent",
    label: "Read Herdr Agent",
    description: "Read recent visible output from a Herdr agent by name or id. Output is truncated to 50KB/2000 lines.",
    parameters: readSchema,
    async execute(_id, params: ReadParams) {
      const result = await createHerdr(pi).readAgent(params.target, params.lines ?? 80)
      return toolText(result.output)
    },
  })

  pi.registerTool({
    name: "herdr_wait_agent",
    label: "Wait Herdr Agent",
    description: "Wait for a Herdr agent to reach a semantic state reported by Herdr.",
    parameters: waitSchema,
    async execute(_id, params: WaitParams) {
      const result = await createHerdr(pi).waitAgent(params.target, params.status ?? "idle", params.timeoutMs ?? 120_000)
      return toolText(result.output || `${params.target} reached ${params.status ?? "idle"}`)
    },
  })

  pi.registerTool({
    name: "herdr_send_agent",
    label: "Send Herdr Agent",
    description: "Send literal text to a Herdr agent by name or id.",
    parameters: sendSchema,
    async execute(_id, params: SendParams) {
      const result = await createHerdr(pi).sendAgent(params.target, params.text)
      return toolText(result.output || `Sent text to ${params.target}`)
    },
  })
}
