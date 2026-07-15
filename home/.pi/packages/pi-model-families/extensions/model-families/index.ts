import { existsSync, readFileSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

type Role = "research" | "architecture" | "planning" | "delivery" | "verification"
type RoutingMode = "auto" | "locked"
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
type TargetModel = {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
}
type ModelFamily = {
  description?: string
  disabled?: boolean
  roles: Partial<Record<Role, TargetModel>>
}
type ModelFamiliesConfig = {
  defaultFamily: string
  autoRoute: boolean
  returnRole: Role
  families: Record<string, ModelFamily>
}
type PersistedState = {
  version: 1
  activeFamily: string
  routingMode: RoutingMode
  lockedModelKey?: string
  timestamp: number
}
type CustomSessionEntry = {
  type: string
  customType?: string
  data?: unknown
}
type RoleRoute = {
  role: Role
  reason: string
}
type PromptOptionsShape = {
  skills?: Array<string | { name?: string; path?: string; description?: string }>
}

const CONFIG_DIR_NAME = ".pi"
const CONFIG_FILE = "model-families.json"
const STATE_ENTRY_TYPE = "model-family-state"
const ROLES = ["research", "architecture", "planning", "delivery", "verification"] as const
const ROLE_SET = new Set<string>(ROLES)
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_ORDER)

const FALLBACK_CONFIG: ModelFamiliesConfig = {
  defaultFamily: "copilot-budget",
  autoRoute: true,
  returnRole: "delivery",
  families: {
    "copilot-budget": {
      description: "Budget Copilot defaults: GPT-5.5 for planning/architecture, MAI-Code for delivery.",
      roles: {
        research: { provider: "github-copilot", model: "gpt-5.5", thinkingLevel: "high" },
        architecture: { provider: "github-copilot", model: "gpt-5.5", thinkingLevel: "high" },
        planning: { provider: "github-copilot", model: "gpt-5.5", thinkingLevel: "high" },
        delivery: { provider: "github-copilot", model: "mai-code-1-flash-picker", thinkingLevel: "low" },
        verification: { provider: "github-copilot", model: "mai-code-1-flash-picker", thinkingLevel: "low" },
      },
    },
  },
}

const ROLE_FALLBACKS: Record<Role, Role[]> = {
  research: ["research", "architecture", "planning", "delivery"],
  architecture: ["architecture", "planning", "research", "delivery"],
  planning: ["planning", "architecture", "research", "delivery"],
  delivery: ["delivery", "verification", "planning"],
  verification: ["verification", "delivery"],
}

const COMMANDS = [
  "status",
  "list",
  "use",
  "auto",
  "default",
  "role",
  "research",
  "architecture",
  "planning",
  "delivery",
  "verification",
  "models",
  "audit",
  "lock",
  "reload",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value)
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return override === undefined ? base : (override as T)
  }

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    if (isRecord(current) && isRecord(value)) {
      merged[key] = deepMerge(current, value)
    } else {
      merged[key] = value
    }
  }
  return merged as T
}

function readJson(path: string, ctx?: ExtensionContext): unknown | undefined {
  if (!existsSync(path)) return undefined

  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    ctx?.ui.notify(`Model families: failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`, "warning")
    return undefined
  }
}

function normalizeTarget(value: unknown): TargetModel | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.provider !== "string" || !value.provider.trim()) return undefined
  if (typeof value.model !== "string" || !value.model.trim()) return undefined

  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    thinkingLevel: isThinkingLevel(value.thinkingLevel) ? value.thinkingLevel : undefined,
  }
}

function normalizeConfig(value: unknown, ctx?: ExtensionContext): ModelFamiliesConfig {
  const source = isRecord(value) ? value : {}
  const rawFamilies = isRecord(source.families) ? source.families : {}
  const families: Record<string, ModelFamily> = {}

  for (const [familyName, rawFamily] of Object.entries(rawFamilies)) {
    if (!isRecord(rawFamily)) continue
    const rawRoles = isRecord(rawFamily.roles) ? rawFamily.roles : {}
    const roles: Partial<Record<Role, TargetModel>> = {}

    for (const [roleName, rawTarget] of Object.entries(rawRoles)) {
      if (!isRole(roleName)) continue
      const target = normalizeTarget(rawTarget)
      if (target) roles[roleName] = target
    }

    if (Object.keys(roles).length === 0) {
      ctx?.ui.notify(`Model families: ignored family ${familyName} because it has no valid roles`, "warning")
      continue
    }

    families[familyName] = {
      description: typeof rawFamily.description === "string" ? rawFamily.description : undefined,
      disabled: rawFamily.disabled === true,
      roles,
    }
  }

  const enabledNames = Object.entries(families).filter(([, family]) => !family.disabled).map(([name]) => name)
  const fallbackDefault = enabledNames[0] ?? Object.keys(families)[0] ?? FALLBACK_CONFIG.defaultFamily
  const configuredDefault = typeof source.defaultFamily === "string" ? families[source.defaultFamily] : undefined
  const defaultFamily = typeof source.defaultFamily === "string" && configuredDefault && !configuredDefault.disabled ? source.defaultFamily : fallbackDefault

  return {
    defaultFamily,
    autoRoute: typeof source.autoRoute === "boolean" ? source.autoRoute : FALLBACK_CONFIG.autoRoute,
    returnRole: isRole(source.returnRole) ? source.returnRole : FALLBACK_CONFIG.returnRole,
    families,
  }
}

function findProjectConfig(cwd: string): string | undefined {
  let dir = cwd
  const root = parse(cwd).root

  while (true) {
    const candidate = join(dir, CONFIG_DIR_NAME, CONFIG_FILE)
    if (existsSync(candidate)) return candidate

    if (existsSync(join(dir, ".git")) || dir === root) return undefined
    dir = dirname(dir)
  }
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  return (ctx as ExtensionContext & { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false
}

function loadConfig(cwd: string, projectTrusted: boolean, ctx?: ExtensionContext): ModelFamiliesConfig {
  const globalPath = join(getAgentDir(), CONFIG_FILE)
  let merged: ModelFamiliesConfig = deepMerge(FALLBACK_CONFIG, readJson(globalPath, ctx) ?? {})

  if (projectTrusted) {
    const projectPath = findProjectConfig(cwd)
    if (projectPath) {
      merged = deepMerge(merged, readJson(projectPath, ctx) ?? {})
    }
  }

  return normalizeConfig(merged, ctx)
}

function parsePersistedState(value: unknown): PersistedState | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== 1) return undefined
  if (typeof value.activeFamily !== "string") return undefined
  if (value.routingMode !== "auto" && value.routingMode !== "locked") return undefined
  if (typeof value.timestamp !== "number") return undefined

  return {
    version: 1,
    activeFamily: value.activeFamily,
    routingMode: value.routingMode,
    lockedModelKey: typeof value.lockedModelKey === "string" ? value.lockedModelKey : undefined,
    timestamp: value.timestamp,
  }
}

function readPersistedState(ctx: ExtensionContext): PersistedState | undefined {
  const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[]
  let latest: PersistedState | undefined
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue
    latest = parsePersistedState(entry.data) ?? latest
  }
  return latest
}

function parseModelKey(value: string): { provider: string; model: string } | undefined {
  const slashIndex = value.indexOf("/")
  if (slashIndex === -1) return undefined
  const provider = value.slice(0, slashIndex)
  const model = value.slice(slashIndex + 1)
  return provider && model ? { provider, model } : undefined
}

function modelKey(target: TargetModel): string {
  return `${target.provider}/${target.model}`
}

function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"
}

function targetForRole(family: ModelFamily, role: Role): { role: Role; target: TargetModel } | undefined {
  for (const candidate of ROLE_FALLBACKS[role]) {
    const target = family.roles[candidate]
    if (target) return { role: candidate, target }
  }
  return undefined
}


type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number]

type ProviderAuthStatusShape = {
  configured?: boolean
  source?: string
  label?: string
}

function familyEnabledEntries(config: ModelFamiliesConfig): Array<[string, ModelFamily]> {
  return Object.entries(config.families).filter(([, family]) => !family.disabled)
}

function familyNames(config: ModelFamiliesConfig, options?: { enabledOnly?: boolean }): string[] {
  const entries = options?.enabledOnly ? familyEnabledEntries(config) : Object.entries(config.families)
  return entries.map(([name]) => name)
}

function supportedThinkingLevels(model: RegistryModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"]

  const thinkingLevelMap = model.thinkingLevelMap as Partial<Record<ThinkingLevel, string | null>> | undefined
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === "xhigh" || level === "max") return mapped !== undefined
    return true
  })
}

function clampThinkingLevel(model: RegistryModel, level: ThinkingLevel): ThinkingLevel {
  const available = supportedThinkingLevels(model)
  if (available.includes(level)) return level

  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level)
  if (requestedIndex === -1) return available[0] ?? "off"

  for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i += 1) {
    const candidate = THINKING_LEVEL_ORDER[i]!
    if (available.includes(candidate)) return candidate
  }

  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVEL_ORDER[i]!
    if (available.includes(candidate)) return candidate
  }

  return available[0] ?? "off"
}

function modelRef(model: RegistryModel): string {
  return `${model.provider}/${model.id}`
}

function authStatusLabel(status: ProviderAuthStatusShape): string {
  if (status.configured) return status.label ? `${status.source ?? "configured"}:${status.label}` : (status.source ?? "configured")
  if (status.source) return status.label ? `unconfigured ${status.source}:${status.label}` : `unconfigured ${status.source}`
  return "missing"
}

function modelMatchesQuery(model: RegistryModel, query: string): boolean {
  if (!query) return true
  const haystack = `${model.provider}\n${model.id}\n${model.name ?? ""}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).every((part) => haystack.includes(part))
}

function envPlaceholders(value: string | undefined): string[] {
  if (!value) return []
  const names = new Set<string>()
  for (const match of value.matchAll(/\{([A-Z0-9_]+)\}/g)) {
    names.add(match[1] ?? "")
  }
  return [...names].filter(Boolean)
}

function missingEnvPlaceholders(model: RegistryModel, ctx: ExtensionContext): string[] {
  const authStorageWithProviderEnv = ctx.modelRegistry.authStorage as { getProviderEnv?: (provider: string) => Record<string, string> | undefined }
  const providerEnv = authStorageWithProviderEnv.getProviderEnv?.(model.provider) ?? {}
  return envPlaceholders(model.baseUrl).filter((name) => !process.env[name] && !providerEnv[name])
}

function formatModelLine(model: RegistryModel, ctx: ExtensionContext): string {
  const available = ctx.modelRegistry.hasConfiguredAuth(model)
  const auth = ctx.modelRegistry.getProviderAuthStatus(model.provider) as ProviderAuthStatusShape
  const missingEnv = missingEnvPlaceholders(model, ctx)
  return [
    `${modelRef(model)}${model.name ? ` — ${model.name}` : ""}`,
    `  available: ${available ? "yes" : "no"}; auth: ${authStatusLabel(auth)}`,
    `  input: ${model.input.join(",")}; reasoning: ${model.reasoning ? "yes" : "no"}; thinking: ${supportedThinkingLevels(model).join(",")}`,
    `  context: ${model.contextWindow ?? "?"}; maxTokens: ${model.maxTokens ?? "?"}${missingEnv.length ? `; missing env: ${missingEnv.join(",")}` : ""}`,
  ].join("\n")
}

function suggestEquivalentModels(target: TargetModel, ctx: ExtensionContext): string[] {
  const suggestions: string[] = []

  if (target.provider === "cloudflare-workers-ai" && target.model.startsWith("@cf/")) {
    const gatewayModel = `workers-ai/${target.model}`
    if (ctx.modelRegistry.find("cloudflare-ai-gateway", gatewayModel)) {
      suggestions.push(`cloudflare-ai-gateway/${gatewayModel}`)
    }
  }

  if (target.provider === "cloudflare-ai-gateway" && target.model.startsWith("workers-ai/@cf/")) {
    const workersModel = target.model.replace(/^workers-ai\//, "")
    if (ctx.modelRegistry.find("cloudflare-workers-ai", workersModel)) {
      suggestions.push(`cloudflare-workers-ai/${workersModel}`)
    }
  }

  const sameId = ctx.modelRegistry.getAll()
    .filter((model) => model.id === target.model && model.provider !== target.provider)
    .slice(0, 5)
    .map((model) => modelRef(model as RegistryModel))

  return [...new Set([...suggestions, ...sameId])]
}

function showModels(query: string, ctx: ExtensionContext): void {
  const matches = ctx.modelRegistry.getAll()
    .filter((model) => modelMatchesQuery(model as RegistryModel, query))
    .sort((a, b) => modelRef(a as RegistryModel).localeCompare(modelRef(b as RegistryModel)))

  const limit = 30
  const lines = matches.slice(0, limit).map((model) => formatModelLine(model as RegistryModel, ctx))
  const suffix = matches.length > limit ? `\n\n...and ${matches.length - limit} more. Refine with /mf models <query>.` : ""
  ctx.ui.notify(lines.length ? `Models (${matches.length}):\n${lines.join("\n\n")}${suffix}` : `No models match: ${query}`, "info")
}

function auditFamily(name: string, family: ModelFamily, ctx: ExtensionContext): string[] {
  const lines = [`${name}${family.disabled ? " [disabled]" : ""}${family.description ? ` — ${family.description}` : ""}`]

  for (const role of ROLES) {
    const resolved = targetForRole(family, role)
    if (!resolved) {
      lines.push(`  ${role}: ✗ missing target`)
      continue
    }

    const via = resolved.role === role ? "" : ` (via ${resolved.role})`
    const target = resolved.target
    const model = ctx.modelRegistry.find(target.provider, target.model) as RegistryModel | undefined
    if (!model) {
      const suggestions = suggestEquivalentModels(target, ctx)
      lines.push(`  ${role}: ✗ ${modelKey(target)}${via} missing${suggestions.length ? `; similar: ${suggestions.join(", ")}` : ""}`)
      continue
    }

    const available = ctx.modelRegistry.hasConfiguredAuth(model)
    const auth = ctx.modelRegistry.getProviderAuthStatus(model.provider) as ProviderAuthStatusShape
    const supported = supportedThinkingLevels(model)
    const thinking = target.thinkingLevel
      ? supported.includes(target.thinkingLevel)
        ? `✓ thinking ${target.thinkingLevel}`
        : `⚠ thinking ${target.thinkingLevel} unsupported; clamps to ${clampThinkingLevel(model, target.thinkingLevel)}`
      : "⚠ thinking unset; current level is retained"
    const missingEnv = missingEnvPlaceholders(model, ctx)
    const envText = missingEnv.length ? `; missing env ${missingEnv.join(",")}` : ""

    lines.push(`  ${role}: ${available ? "✓" : "⚠"} ${modelKey(target)}${via}; available ${available ? "yes" : "no"}; auth ${authStatusLabel(auth)}; input ${model.input.join(",")}; ${thinking}${envText}`)
  }

  return lines
}

function showAudit(familyName: string | undefined, config: ModelFamiliesConfig, ctx: ExtensionContext): void {
  const entries = familyName
    ? Object.entries(config.families).filter(([name]) => name === familyName)
    : Object.entries(config.families)

  if (familyName && entries.length === 0) {
    ctx.ui.notify(`Model families: unknown family ${familyName}\n${helpText(config)}`, "warning")
    return
  }

  const lines = entries.flatMap(([name, family]) => auditFamily(name, family, ctx))
  ctx.ui.notify(`Model family audit:\n${lines.join("\n")}`, "info")
}

function skillNames(options: unknown): string[] {
  const skills = (options as PromptOptionsShape | undefined)?.skills
  if (!Array.isArray(skills)) return []

  return skills
    .map((skill) => {
      if (typeof skill === "string") return skill
      return skill.name ?? skill.path?.split("/").filter(Boolean).pop() ?? ""
    })
    .filter(Boolean)
}

function classify(prompt: string, options: unknown): RoleRoute {
  const skills = skillNames(options)
  const joined = `${prompt}\n${skills.join("\n")}`

  if (/\b(?:research|web search|search (?:the )?web|look up|current|latest|docs?|documentation|api reference|official docs?|sources?|compare options|market|vendor)\b/i.test(joined)) {
    return { role: "research", reason: "research/docs/current-info signal" }
  }

  if (/\b(?:architecture|architectural|system design|technical design|design doc|domain model|data model|state machine|adr|decision record|plan|planning|prd|proposal|approach|strategy|refactor|re-?architect|re-?design|deep module|interface design)\b/i.test(joined)) {
    return { role: /\bplan|planning|prd|proposal|approach|strategy\b/i.test(joined) ? "planning" : "architecture", reason: "planning/architecture signal" }
  }

  if (/\b(?:verify|verification|test|tests|lint|typecheck|check|validate|ci|review evidence|acceptance)\b/i.test(joined)) {
    return { role: "verification", reason: "verification signal" }
  }

  if (/\b(?:implement|build|deliver|code|fix|debug|diagnose|repair|failing|broken|bug|feature|wire up|ship)\b/i.test(joined)) {
    return { role: "delivery", reason: "delivery signal" }
  }

  return { role: "delivery", reason: "default" }
}

function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean)
}

function helpText(config: ModelFamiliesConfig): string {
  return [
    "Usage: /model-family [status|list|use <family>|auto [family]|default|role <role> [prompt]|<role> [prompt]|models [query]|audit [family]|lock|reload]",
    `Families: ${familyNames(config, { enabledOnly: true }).join(", ")}`,
    `Disabled: ${familyNames(config).filter((name) => config.families[name]?.disabled).join(", ") || "none"}`,
    `Roles: ${ROLES.join(", ")}`,
  ].join("\n")
}

export default function modelFamilies(pi: ExtensionAPI) {
  let config = FALLBACK_CONFIG
  let activeFamily = FALLBACK_CONFIG.defaultFamily
  let routingMode: RoutingMode = FALLBACK_CONFIG.autoRoute ? "auto" : "locked"
  let lockedModelKey: string | undefined
  let selectedByExtension = false
  let thinkingSetByExtension = false
  let ignoreThinkingSelectionsUntil = 0
  let lastStateSnapshot: string | undefined
  let nextRoute: RoleRoute | undefined
  let currentTurnRole: Role | undefined

  function persistState(): void {
    const state: PersistedState = {
      version: 1,
      activeFamily,
      routingMode,
      lockedModelKey,
      timestamp: Date.now(),
    }
    const snapshot = JSON.stringify({ ...state, timestamp: 0 })
    if (snapshot === lastStateSnapshot) return
    pi.appendEntry(STATE_ENTRY_TYPE, state)
    lastStateSnapshot = snapshot
  }

  function setStatus(ctx: ExtensionContext, role?: Role): void {
    const modeLabel = routingMode === "locked" ? `locked:${lockedModelKey ?? currentModelKey(ctx)}` : `auto:${activeFamily}`
    ctx.ui.setStatus("model-family-mode", modeLabel)
    ctx.ui.setStatus("model-family-role", role ? `${activeFamily}:${role}` : activeFamily)
  }

  function showStatus(ctx: ExtensionContext): void {
    const family = config.families[activeFamily]
    const roleLines = family
      ? ROLES.map((role) => {
          const resolved = targetForRole(family, role)
          if (!resolved) return `  ${role}: missing`
          const suffix = resolved.role === role ? "" : ` (via ${resolved.role})`
          return `  ${role}: ${modelKey(resolved.target)}${resolved.target.thinkingLevel ? ` (${resolved.target.thinkingLevel})` : ""}${suffix}`
        }).join("\n")
      : "  missing active family"

    ctx.ui.notify(
      [
        `Model family: mode=${routingMode}, active=${activeFamily}, default=${config.defaultFamily}`,
        `Current model: ${currentModelKey(ctx)}`,
        `Locked model: ${lockedModelKey ?? "none"}`,
        `Auto route: ${config.autoRoute}; return role: ${config.returnRole}`,
        "Active family roles:",
        roleLines,
      ].join("\n"),
      "info"
    )
  }

  async function applyRole(requestedRole: Role, reason: string, ctx: ExtensionContext): Promise<boolean> {
    const family = config.families[activeFamily]
    if (!family) {
      ctx.ui.notify(`Model families: unknown active family ${activeFamily}`, "warning")
      return false
    }

    const resolved = targetForRole(family, requestedRole)
    if (!resolved) {
      ctx.ui.notify(`Model families: ${activeFamily} has no model for ${requestedRole}`, "warning")
      return false
    }

    const { role, target } = resolved
    const targetKey = modelKey(target)
    const beforeKey = currentModelKey(ctx)
    const model = ctx.modelRegistry.find(target.provider, target.model)

    if (!model) {
      ctx.ui.notify(`Model families: missing ${targetKey} for ${activeFamily}:${role}`, "warning")
      return false
    }

    if (beforeKey !== targetKey) {
      selectedByExtension = true
      ignoreThinkingSelectionsUntil = Date.now() + 750
      try {
        const ok = await pi.setModel(model)
        if (!ok) {
          ctx.ui.notify(`Model families: no API key for ${targetKey}`, "warning")
          return false
        }
      } finally {
        selectedByExtension = false
      }
    }

    if (target.thinkingLevel) {
      thinkingSetByExtension = true
      ignoreThinkingSelectionsUntil = Date.now() + 750
      try {
        pi.setThinkingLevel(target.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0])
      } finally {
        thinkingSetByExtension = false
      }
    }

    setStatus(ctx, role)
    if (beforeKey !== targetKey) {
      ctx.ui.notify(`Model families: ${beforeKey} → ${targetKey} (${activeFamily}:${role}; ${reason})`, "info")
    }
    return true
  }

  async function useFamily(familyName: string, ctx: ExtensionContext): Promise<void> {
    const family = config.families[familyName]
    if (!family) {
      ctx.ui.notify(`Model families: unknown family ${familyName}\n${helpText(config)}`, "warning")
      return
    }
    if (family.disabled) {
      ctx.ui.notify(`Model families: ${familyName} is disabled. Set disabled=false in ${CONFIG_FILE} and reload to use it.`, "warning")
      return
    }

    activeFamily = familyName
    routingMode = "auto"
    lockedModelKey = undefined
    nextRoute = undefined
    currentTurnRole = undefined
    setStatus(ctx)
    persistState()
    await applyRole(config.returnRole, `selected family ${familyName}`, ctx)
  }

  async function queueRole(role: Role, prompt: string, ctx: ExtensionContext): Promise<void> {
    routingMode = "auto"
    lockedModelKey = undefined
    nextRoute = { role, reason: `manual one-shot ${role}` }
    setStatus(ctx, role)
    persistState()
    await applyRole(role, `manual one-shot ${role}`, ctx)

    if (!prompt) {
      ctx.ui.notify(`Model families: queued ${activeFamily}:${role} for the next turn`, "info")
      return
    }

    if (ctx.isIdle()) {
      pi.sendUserMessage(prompt)
    } else {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" })
    }
  }

  async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const parts = splitArgs(args)
    const command = parts[0]?.toLowerCase()

    if (!command || command === "status") {
      showStatus(ctx)
      return
    }

    if (command === "list") {
      const lines = Object.entries(config.families).map(([name, family]) => `  ${name}${name === activeFamily ? " *" : ""}${family.disabled ? " [disabled]" : ""}${family.description ? ` — ${family.description}` : ""}`)
      ctx.ui.notify(`Model families:\n${lines.join("\n")}`, "info")
      return
    }

    if (command === "models") {
      showModels(parts.slice(1).join(" "), ctx)
      return
    }

    if (command === "audit") {
      showAudit(parts[1], config, ctx)
      return
    }

    if (command === "reload") {
      config = loadConfig(ctx.cwd, isProjectTrusted(ctx), ctx)
      if (!config.families[activeFamily] || config.families[activeFamily]?.disabled) activeFamily = config.defaultFamily
      routingMode = config.autoRoute ? "auto" : "locked"
      lockedModelKey = routingMode === "locked" ? currentModelKey(ctx) : undefined
      nextRoute = undefined
      setStatus(ctx)
      persistState()
      await applyRole(config.returnRole, "reloaded config", ctx)
      showStatus(ctx)
      return
    }

    if (command === "lock") {
      routingMode = "locked"
      lockedModelKey = currentModelKey(ctx)
      nextRoute = undefined
      setStatus(ctx)
      persistState()
      ctx.ui.notify(`Model families: locked to ${lockedModelKey}`, "info")
      return
    }

    if (command === "default") {
      await useFamily(config.defaultFamily, ctx)
      return
    }

    if (command === "use" || command === "auto") {
      await useFamily(parts[1] ?? activeFamily, ctx)
      return
    }

    if (command === "role") {
      const role = parts[1]
      if (!isRole(role)) {
        ctx.ui.notify(helpText(config), "warning")
        return
      }
      const prompt = parts.slice(2).join(" ")
      await queueRole(role, prompt, ctx)
      return
    }

    if (isRole(command)) {
      const prompt = parts.slice(1).join(" ")
      await queueRole(command, prompt, ctx)
      return
    }

    if (config.families[command]) {
      await useFamily(command, ctx)
      return
    }

    ctx.ui.notify(helpText(config), "warning")
  }

  pi.registerCommand("model-family", {
    description: "Select and inspect role-based model families",
    getArgumentCompletions: (prefix) => {
      const parts = splitArgs(prefix)
      const last = parts.at(-1) ?? ""
      const suggestFamilies = prefix.endsWith(" ") || ["use", "auto", "audit"].includes(parts[0] ?? "")
      const source = suggestFamilies ? familyNames(config, { enabledOnly: !["audit"].includes(parts[0] ?? "") }) : [...COMMANDS, ...familyNames(config)]
      const items = source
        .filter((value) => value.startsWith(last))
        .map((value) => ({ value, label: value }))
      return items.length > 0 ? items : null
    },
    handler: handleCommand,
  })

  pi.registerCommand("mf", {
    description: "Alias for /model-family",
    getArgumentCompletions: (prefix) => {
      const source = [...COMMANDS, ...familyNames(config)]
      const items = source
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }))
      return items.length > 0 ? items : null
    },
    handler: handleCommand,
  })

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd, isProjectTrusted(ctx), ctx)
    activeFamily = config.defaultFamily
    routingMode = config.autoRoute ? "auto" : "locked"
    lockedModelKey = undefined

    const restored = readPersistedState(ctx)
    if (restored && config.families[restored.activeFamily] && !config.families[restored.activeFamily]?.disabled) {
      activeFamily = restored.activeFamily
      routingMode = restored.routingMode
      lockedModelKey = restored.lockedModelKey
    }

    setStatus(ctx)

    if (routingMode === "locked" && lockedModelKey) {
      const lockedModel = parseModelKey(lockedModelKey)
      const model = lockedModel ? ctx.modelRegistry.find(lockedModel.provider, lockedModel.model) : undefined
      if (model) {
        selectedByExtension = true
        try {
          await pi.setModel(model)
        } finally {
          selectedByExtension = false
        }
      } else {
        ctx.ui.notify(`Model families: locked model unavailable: ${lockedModelKey}; resuming auto`, "warning")
        routingMode = "auto"
        lockedModelKey = undefined
        persistState()
      }
    }
  })

  pi.on("model_select", async (event, ctx) => {
    if (selectedByExtension || event.source === "restore") return
    routingMode = "locked"
    lockedModelKey = `${event.model.provider}/${event.model.id}`
    nextRoute = undefined
    setStatus(ctx)
    persistState()
  })

  pi.on("thinking_level_select", () => {
    if (thinkingSetByExtension || selectedByExtension || Date.now() < ignoreThinkingSelectionsUntil) return
    // Manual thinking changes are intentionally not persisted as family overrides. Put durable
    // thinking defaults in model-families.json so project overrides stay reviewable.
  })

  pi.on("before_agent_start", async (event, ctx) => {
    currentTurnRole = undefined
    if (routingMode === "locked") return

    if (nextRoute) {
      const route = nextRoute
      nextRoute = undefined
      currentTurnRole = route.role
      await applyRole(route.role, route.reason, ctx)
      return
    }

    const route = classify(event.prompt, event.systemPromptOptions)
    currentTurnRole = route.role
    await applyRole(route.role, route.reason, ctx)
  })

  pi.on("agent_end", async (_event, ctx) => {
    if (routingMode !== "auto" || !currentTurnRole || currentTurnRole === config.returnRole) return

    currentTurnRole = undefined
    await applyRole(config.returnRole, "return to default role after elevated turn", ctx)
  })
}
