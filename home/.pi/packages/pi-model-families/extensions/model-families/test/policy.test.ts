import { describe, expect, test } from "bun:test"
import {
  classifyPrompt,
  normalizeConfig,
  planTransition,
  resolveManualTarget,
  targetForRole,
  type ModelFamiliesConfig,
} from "../policy"

const terra = {
  provider: "azure-openai-responses",
  model: "gpt-5.6-terra",
  thinkingLevel: "medium" as const,
}

const config: ModelFamiliesConfig = {
  defaultFamily: "azure-gpt",
  autoRoute: true,
  returnRole: "delivery",
  families: {
    "azure-gpt": {
      roles: {
        research: terra,
        architecture: terra,
        planning: terra,
        delivery: terra,
        verification: terra,
      },
      manualTargets: {
        sol: {
          provider: "azure-openai-responses",
          model: "gpt-5.6-sol",
          thinkingLevel: "high",
          description: "Exceptional long-horizon reasoning",
        },
        luna: {
          provider: "azure-openai-responses",
          model: "gpt-5.6-luna",
          thinkingLevel: "low",
          description: "Explicit budget work",
        },
      },
    },
  },
}

describe("prompt classification", () => {
  test("loaded skill names cannot influence a delivery prompt", () => {
    expect(classifyPrompt("fix the parser")).toEqual({
      role: "delivery",
      reason: "delivery signal",
    })
  })

  test("implementation intent wins over incidental verification words", () => {
    expect(classifyPrompt("fix the failing test").role).toBe("delivery")
  })

  test("explicit current-information research still routes as research", () => {
    expect(classifyPrompt("research the latest official API docs").role).toBe("research")
  })
})

describe("route resolution", () => {
  test("all automatic Azure roles can resolve to one cache-stable target", () => {
    const family = config.families["azure-gpt"]!
    for (const role of ["research", "architecture", "planning", "delivery", "verification"] as const) {
      expect(targetForRole(family, role)?.target).toEqual(terra)
    }
  })

  test("manual premium and budget targets are named and explicit", () => {
    const family = config.families["azure-gpt"]!
    expect(resolveManualTarget(family, "sol")?.model).toBe("gpt-5.6-sol")
    expect(resolveManualTarget(family, "luna")?.model).toBe("gpt-5.6-luna")
    expect(resolveManualTarget(family, "missing")).toBeUndefined()
  })

  test("normal routing is a no-op when model and thinking already match", () => {
    expect(planTransition("azure-openai-responses/gpt-5.6-terra", "medium", terra)).toEqual({
      changeModel: false,
      changeThinking: false,
    })
  })
})

describe("configuration", () => {
  test("normalizes manual targets without making them automatic roles", () => {
    const normalized = normalizeConfig(config)
    const family = normalized.families["azure-gpt"]!
    expect(family.manualTargets?.sol).toEqual(config.families["azure-gpt"]!.manualTargets?.sol)
    expect(targetForRole(family, "research")?.target.model).toBe("gpt-5.6-terra")
  })
})
