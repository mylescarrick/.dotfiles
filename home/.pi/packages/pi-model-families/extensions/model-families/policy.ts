export type Role = "research" | "architecture" | "planning" | "delivery" | "verification";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TargetModel {
  model: string;
  provider: string;
  thinkingLevel?: ThinkingLevel;
}

export type ManualTarget = TargetModel & {
  description?: string;
};

export interface ModelFamily {
  description?: string;
  disabled?: boolean;
  manualTargets?: Record<string, ManualTarget>;
  roles: Partial<Record<Role, TargetModel>>;
}

export interface ModelFamiliesConfig {
  autoRoute: boolean;
  defaultFamily: string;
  families: Record<string, ModelFamily>;
  returnRole: Role;
}

export interface RoleRoute {
  reason: string;
  role: Role;
}

export const ROLES = ["research", "architecture", "planning", "delivery", "verification"] as const;
export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ROLE_SET = new Set<string>(ROLES);
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_ORDER);

export const FALLBACK_CONFIG: ModelFamiliesConfig = {
  autoRoute: true,
  defaultFamily: "copilot-budget",
  families: {
    "copilot-budget": {
      description: "Budget Copilot defaults: GPT-5.5 for planning/architecture, MAI-Code for delivery.",
      roles: {
        architecture: { model: "gpt-5.5", provider: "github-copilot", thinkingLevel: "high" },
        delivery: { model: "mai-code-1-flash-picker", provider: "github-copilot", thinkingLevel: "low" },
        planning: { model: "gpt-5.5", provider: "github-copilot", thinkingLevel: "high" },
        research: { model: "gpt-5.5", provider: "github-copilot", thinkingLevel: "high" },
        verification: { model: "mai-code-1-flash-picker", provider: "github-copilot", thinkingLevel: "low" },
      },
    },
  },
  returnRole: "delivery",
};

const ROLE_FALLBACKS: Record<Role, Role[]> = {
  architecture: ["architecture", "planning", "research", "delivery"],
  delivery: ["delivery", "verification", "planning"],
  planning: ["planning", "architecture", "research", "delivery"],
  research: ["research", "architecture", "planning", "delivery"],
  verification: ["verification", "delivery"],
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!(isRecord(base) && isRecord(override))) {
    return override === undefined ? base : (override as T);
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return merged as T;
}

function normalizeTarget(value: unknown): TargetModel | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.provider !== "string" || !value.provider.trim()) return undefined;
  if (typeof value.model !== "string" || !value.model.trim()) return undefined;

  return {
    model: value.model.trim(),
    provider: value.provider.trim(),
    thinkingLevel: isThinkingLevel(value.thinkingLevel) ? value.thinkingLevel : undefined,
  };
}

export function normalizeConfig(value: unknown): ModelFamiliesConfig {
  const source = isRecord(value) ? value : {};
  const rawFamilies = isRecord(source.families) ? source.families : {};
  const families: Record<string, ModelFamily> = {};

  for (const [familyName, rawFamily] of Object.entries(rawFamilies)) {
    if (!isRecord(rawFamily)) continue;
    const rawRoles = isRecord(rawFamily.roles) ? rawFamily.roles : {};
    const roles: Partial<Record<Role, TargetModel>> = {};

    for (const [roleName, rawTarget] of Object.entries(rawRoles)) {
      if (!isRole(roleName)) continue;
      const target = normalizeTarget(rawTarget);
      if (target) roles[roleName] = target;
    }

    if (Object.keys(roles).length === 0) continue;

    const rawManualTargets = isRecord(rawFamily.manualTargets) ? rawFamily.manualTargets : {};
    const manualTargets: Record<string, ManualTarget> = {};
    for (const [targetName, rawTarget] of Object.entries(rawManualTargets)) {
      const target = normalizeTarget(rawTarget);
      if (!target) continue;
      manualTargets[targetName] = {
        ...target,
        description:
          isRecord(rawTarget) && typeof rawTarget.description === "string"
            ? rawTarget.description
            : undefined,
      };
    }

    families[familyName] = {
      description: typeof rawFamily.description === "string" ? rawFamily.description : undefined,
      disabled: rawFamily.disabled === true,
      roles,
      ...(Object.keys(manualTargets).length > 0 ? { manualTargets } : {}),
    };
  }

  const enabledNames = Object.entries(families)
    .filter(([, family]) => !family.disabled)
    .map(([name]) => name);
  const fallbackDefault = enabledNames[0] ?? Object.keys(families)[0] ?? FALLBACK_CONFIG.defaultFamily;
  const configuredDefault =
    typeof source.defaultFamily === "string" ? families[source.defaultFamily] : undefined;
  const defaultFamily =
    typeof source.defaultFamily === "string" && configuredDefault && !configuredDefault.disabled
      ? source.defaultFamily
      : fallbackDefault;

  return {
    autoRoute: typeof source.autoRoute === "boolean" ? source.autoRoute : FALLBACK_CONFIG.autoRoute,
    defaultFamily,
    families,
    returnRole: isRole(source.returnRole) ? source.returnRole : FALLBACK_CONFIG.returnRole,
  };
}

export function targetForRole(
  family: ModelFamily,
  role: Role
): { role: Role; target: TargetModel } | undefined {
  for (const candidate of ROLE_FALLBACKS[role]) {
    const target = family.roles[candidate];
    if (target) return { role: candidate, target };
  }
  return undefined;
}

export function resolveManualTarget(family: ModelFamily, name: string): ManualTarget | undefined {
  return family.manualTargets?.[name];
}

export function modelKey(target: TargetModel): string {
  return `${target.provider}/${target.model}`;
}

export function planTransition(
  currentModel: string,
  currentThinking: string,
  target: TargetModel
): { changeModel: boolean; changeThinking: boolean } {
  return {
    changeModel: currentModel !== modelKey(target),
    changeThinking: target.thinkingLevel !== undefined && currentThinking !== target.thinkingLevel,
  };
}

export function classifyPrompt(prompt: string): RoleRoute {
  if (
    /\b(?:research|web search|search (?:the )?web|look up|current|latest|docs?|documentation|api reference|official docs?|sources?|compare options|market|vendor)\b/i.test(
      prompt
    )
  ) {
    return { reason: "research/docs/current-info signal", role: "research" };
  }

  if (
    /\b(?:architecture|architectural|system design|technical design|design doc|domain model|data model|state machine|adr|decision record|plan|planning|prd|proposal|approach|strategy|refactor|re-?architect|re-?design|deep module|interface design)\b/i.test(
      prompt
    )
  ) {
    return {
      reason: "planning/architecture signal",
      role: /\bplan|planning|prd|proposal|approach|strategy\b/i.test(prompt) ? "planning" : "architecture",
    };
  }

  // Implementation intent wins when prompts mention tests as part of fixing or building.
  if (
    /\b(?:implement|build|deliver|code|fix|debug|diagnose|repair|failing|broken|bug|feature|wire up|ship)\b/i.test(
      prompt
    )
  ) {
    return { reason: "delivery signal", role: "delivery" };
  }

  if (
    /\b(?:verify|verification|test|tests|lint|typecheck|check|validate|ci|review evidence|acceptance)\b/i.test(
      prompt
    )
  ) {
    return { reason: "verification signal", role: "verification" };
  }

  return { reason: "default", role: "delivery" };
}
