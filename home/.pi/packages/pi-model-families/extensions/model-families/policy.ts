export type Role = "research" | "architecture" | "planning" | "delivery" | "verification"
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type TargetModel = {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
}

export type ManualTarget = TargetModel & {
  description?: string
}

export type ModelFamily = {
  description?: string
  disabled?: boolean
  roles: Partial<Record<Role, TargetModel>>
  manualTargets?: Record<string, ManualTarget>
}

export type ModelFamiliesConfig = {
  defaultFamily: string
  autoRoute: boolean
  returnRole: Role
  families: Record<string, ModelFamily>
}

export type RoleRoute = {
  role: Role
  reason: string
}

export const ROLES = ["research", "architecture", "planning", "delivery", "verification"] as const
export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const ROLE_SET = new Set<string>(ROLES)
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_ORDER)

export const FALLBACK_CONFIG: ModelFamiliesConfig = {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value)
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value)
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return override === undefined ? base : (override as T)
  }

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value
  }
  return merged as T
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

export function normalizeConfig(value: unknown): ModelFamiliesConfig {
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

    if (Object.keys(roles).length === 0) continue

    const rawManualTargets = isRecord(rawFamily.manualTargets) ? rawFamily.manualTargets : {}
    const manualTargets: Record<string, ManualTarget> = {}
    for (const [targetName, rawTarget] of Object.entries(rawManualTargets)) {
      const target = normalizeTarget(rawTarget)
      if (!target) continue
      manualTargets[targetName] = {
        ...target,
        description: isRecord(rawTarget) && typeof rawTarget.description === "string"
          ? rawTarget.description
          : undefined,
      }
    }

    families[familyName] = {
      description: typeof rawFamily.description === "string" ? rawFamily.description : undefined,
      disabled: rawFamily.disabled === true,
      roles,
      ...(Object.keys(manualTargets).length > 0 ? { manualTargets } : {}),
    }
  }

  const enabledNames = Object.entries(families).filter(([, family]) => !family.disabled).map(([name]) => name)
  const fallbackDefault = enabledNames[0] ?? Object.keys(families)[0] ?? FALLBACK_CONFIG.defaultFamily
  const configuredDefault = typeof source.defaultFamily === "string" ? families[source.defaultFamily] : undefined
  const defaultFamily = typeof source.defaultFamily === "string" && configuredDefault && !configuredDefault.disabled
    ? source.defaultFamily
    : fallbackDefault

  return {
    defaultFamily,
    autoRoute: typeof source.autoRoute === "boolean" ? source.autoRoute : FALLBACK_CONFIG.autoRoute,
    returnRole: isRole(source.returnRole) ? source.returnRole : FALLBACK_CONFIG.returnRole,
    families,
  }
}

export function targetForRole(family: ModelFamily, role: Role): { role: Role; target: TargetModel } | undefined {
  for (const candidate of ROLE_FALLBACKS[role]) {
    const target = family.roles[candidate]
    if (target) return { role: candidate, target }
  }
  return undefined
}

export function resolveManualTarget(family: ModelFamily, name: string): ManualTarget | undefined {
  return family.manualTargets?.[name]
}

export function modelKey(target: TargetModel): string {
  return `${target.provider}/${target.model}`
}

export function planTransition(
  currentModel: string,
  currentThinking: string,
  target: TargetModel,
): { changeModel: boolean; changeThinking: boolean } {
  return {
    changeModel: currentModel !== modelKey(target),
    changeThinking: target.thinkingLevel !== undefined && currentThinking !== target.thinkingLevel,
  }
}

export function classifyPrompt(prompt: string): RoleRoute {
  if (/\b(?:research|web search|search (?:the )?web|look up|current|latest|docs?|documentation|api reference|official docs?|sources?|compare options|market|vendor)\b/i.test(prompt)) {
    return { role: "research", reason: "research/docs/current-info signal" }
  }

  if (/\b(?:architecture|architectural|system design|technical design|design doc|domain model|data model|state machine|adr|decision record|plan|planning|prd|proposal|approach|strategy|refactor|re-?architect|re-?design|deep module|interface design)\b/i.test(prompt)) {
    return {
      role: /\bplan|planning|prd|proposal|approach|strategy\b/i.test(prompt) ? "planning" : "architecture",
      reason: "planning/architecture signal",
    }
  }

  // Implementation intent wins when prompts mention tests as part of fixing or building.
  if (/\b(?:implement|build|deliver|code|fix|debug|diagnose|repair|failing|broken|bug|feature|wire up|ship)\b/i.test(prompt)) {
    return { role: "delivery", reason: "delivery signal" }
  }

  if (/\b(?:verify|verification|test|tests|lint|typecheck|check|validate|ci|review evidence|acceptance)\b/i.test(prompt)) {
    return { role: "verification", reason: "verification signal" }
  }

  return { role: "delivery", reason: "default" }
}
