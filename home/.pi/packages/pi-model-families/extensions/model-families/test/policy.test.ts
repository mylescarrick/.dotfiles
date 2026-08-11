import { describe, expect, test } from "bun:test";
import {
  classifyPrompt,
  type ModelFamiliesConfig,
  normalizeConfig,
  planTransition,
  resolveManualTarget,
  targetForRole,
} from "../policy";

const terra = {
  model: "gpt-5.6-terra",
  provider: "azure-openai-responses",
  thinkingLevel: "medium" as const,
};

const config: ModelFamiliesConfig = {
  autoRoute: true,
  defaultFamily: "azure-gpt",
  families: {
    "azure-gpt": {
      manualTargets: {
        luna: {
          description: "Explicit budget work",
          model: "gpt-5.6-luna",
          provider: "azure-openai-responses",
          thinkingLevel: "low",
        },
        sol: {
          description: "Exceptional long-horizon reasoning",
          model: "gpt-5.6-sol",
          provider: "azure-openai-responses",
          thinkingLevel: "high",
        },
      },
      roles: {
        architecture: terra,
        delivery: terra,
        planning: terra,
        research: terra,
        verification: terra,
      },
    },
  },
  returnRole: "delivery",
};

describe("prompt classification", () => {
  test("loaded skill names cannot influence a delivery prompt", () => {
    expect(classifyPrompt("fix the parser")).toEqual({
      reason: "delivery signal",
      role: "delivery",
    });
  });

  test("implementation intent wins over incidental verification words", () => {
    expect(classifyPrompt("fix the failing test").role).toBe("delivery");
  });

  test("explicit current-information research still routes as research", () => {
    expect(classifyPrompt("research the latest official API docs").role).toBe("research");
  });
});

describe("route resolution", () => {
  test("all automatic Azure roles can resolve to one cache-stable target", () => {
    const family = config.families["azure-gpt"]!;
    for (const role of ["research", "architecture", "planning", "delivery", "verification"] as const) {
      expect(targetForRole(family, role)?.target).toEqual(terra);
    }
  });

  test("manual premium and budget targets are named and explicit", () => {
    const family = config.families["azure-gpt"]!;
    expect(resolveManualTarget(family, "sol")?.model).toBe("gpt-5.6-sol");
    expect(resolveManualTarget(family, "luna")?.model).toBe("gpt-5.6-luna");
    expect(resolveManualTarget(family, "missing")).toBeUndefined();
  });

  test("normal routing is a no-op when model and thinking already match", () => {
    expect(planTransition("azure-openai-responses/gpt-5.6-terra", "medium", terra)).toEqual({
      changeModel: false,
      changeThinking: false,
    });
  });
});

describe("configuration", () => {
  test("normalizes manual targets without making them automatic roles", () => {
    const normalized = normalizeConfig(config);
    const family = normalized.families["azure-gpt"]!;
    expect(family.manualTargets?.sol).toEqual(config.families["azure-gpt"]!.manualTargets?.sol);
    expect(targetForRole(family, "research")?.target.model).toBe("gpt-5.6-terra");
  });
});
