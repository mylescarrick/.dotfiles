export type HerdrRole = "researcher" | "architect" | "planner" | "executor" | "reviewer" | "verifier"
export type ModelFamilyRole = "research" | "architecture" | "planning" | "delivery" | "verification"

export const HERDR_ROLES = ["researcher", "architect", "planner", "executor", "reviewer", "verifier"] as const

export const ROLE_TO_MODEL_ROLE: Record<HerdrRole, ModelFamilyRole> = {
  researcher: "research",
  architect: "architecture",
  planner: "planning",
  executor: "delivery",
  reviewer: "verification",
  verifier: "verification",
}

export const ROLE_DEFAULT_TOOLS: Record<HerdrRole, string[] | undefined> = {
  researcher: ["read", "grep", "find", "ls"],
  architect: ["read", "grep", "find", "ls"],
  planner: ["read", "grep", "find", "ls"],
  executor: undefined,
  reviewer: ["read", "grep", "find", "ls"],
  verifier: ["read", "grep", "find", "ls", "bash"],
}

export function isHerdrRole(value: string): value is HerdrRole {
  return (HERDR_ROLES as readonly string[]).includes(value)
}

export function buildWorkerPrompt(options: {
  role: HerdrRole
  parentPrompt: string
  writable: boolean
  cwd: string
}): string {
  const mode = options.writable ? "write-capable" : "read-only"
  const guardrails = options.writable
    ? [
        "You may edit files only to complete the delegated task.",
        "Do not commit unless the parent prompt explicitly instructs you to commit.",
        "Keep changes scoped; report files changed and verification evidence.",
      ]
    : [
        "Read-only mode: do not edit files, write files, run formatters, or commit.",
        "Use only inspection commands/tools available to you.",
        "Return concise findings with file paths and line references when useful.",
      ]

  return [
    `You are a visible Herdr-managed Pi worker agent running in ${mode} mode.`,
    `Role: ${options.role}`,
    `Working directory: ${options.cwd}`,
    "",
    "Rules:",
    ...guardrails.map((line) => `- ${line}`),
    "- Do not spawn additional subagents.",
    "- Optimize for a compact final answer; the parent agent will synthesize results.",
    "- If blocked, say exactly what you need from the parent/user.",
    "",
    "Delegated task:",
    options.parentPrompt.trim(),
  ].join("\n")
}

export function slugifyAgentName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || "pi-worker"
}

export function defaultAgentName(role: HerdrRole): string {
  return `${role}-${Date.now().toString(36)}`
}
