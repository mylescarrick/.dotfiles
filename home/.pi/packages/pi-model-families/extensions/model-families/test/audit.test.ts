import { describe, expect, test } from "bun:test";
import { missingEnvPlaceholders } from "../index";

describe("audit helpers", () => {
  test("missing auth storage does not crash env placeholder lookup", () => {
    const original = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    try {
      const model = {
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
        contextWindow: 262144,
        id: "@cf/moonshotai/kimi-k2.7-code",
        input: ["text"],
        maxTokens: 262144,
        name: "Kimi K2.7 Code",
        provider: "cloudflare-workers-ai",
        reasoning: true,
      };

      const ctx = {
        modelRegistry: {
          authStorage: undefined,
          find: () => undefined,
          getAll: () => [],
          getProviderAuthStatus: () => ({ configured: false, label: undefined, source: undefined }),
          hasConfiguredAuth: () => false,
        },
      } as any;

      expect(missingEnvPlaceholders(model as any, ctx)).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
    } finally {
      if (original !== undefined) {
        process.env.CLOUDFLARE_ACCOUNT_ID = original;
      }
    }
  });
});
