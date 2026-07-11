import { existsSync, readFileSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import type { ModelFamilyRole } from "./prompts.ts"

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

type TargetModel = {
  provider: string
  model: string
  thinkingLevel?: ThinkingLevel
}

type ModelFamily = {
  roles?: Partial<Record<ModelFamilyRole, TargetModel>>
}

type ModelFamiliesConfig = {
  defaultFamily?: string
  families?: Record<string, ModelFamily>
}

const CONFIG_DIR_NAME = ".pi"
const CONFIG_FILE = "model-families.json"
const ROLE_FALLBACKS: Record<ModelFamilyRole, ModelFamilyRole[]> = {
  research: ["research", "architecture", "planning", "delivery"],
  architecture: ["architecture", "planning", "research", "delivery"],
  planning: ["planning", "architecture", "research", "delivery"],
  delivery: ["delivery", "verification", "planning"],
  verification: ["verification", "delivery"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : (override as T)

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key]
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value
  }
  return merged as T
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
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

function loadConfig(cwd: string, projectTrusted: boolean): ModelFamiliesConfig {
  let config: ModelFamiliesConfig = {}
  config = deepMerge(config, readJson(join(getAgentDir(), CONFIG_FILE)) ?? {})

  if (projectTrusted) {
    const projectConfig = findProjectConfig(cwd)
    if (projectConfig) config = deepMerge(config, readJson(projectConfig) ?? {})
  }

  return config
}

function targetForRole(family: ModelFamily | undefined, role: ModelFamilyRole): TargetModel | undefined {
  if (!family?.roles) return undefined
  for (const candidate of ROLE_FALLBACKS[role]) {
    const target = family.roles[candidate]
    if (target) return target
  }
  return undefined
}

export function resolveModelFamilyTarget(options: {
  cwd: string
  projectTrusted: boolean
  family?: string
  role: ModelFamilyRole
}): TargetModel | undefined {
  const config = loadConfig(options.cwd, options.projectTrusted)
  const familyName = options.family ?? config.defaultFamily
  if (!familyName) return undefined
  return targetForRole(config.families?.[familyName], options.role)
}
