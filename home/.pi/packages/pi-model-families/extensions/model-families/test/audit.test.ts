import { describe, expect, test } from "bun:test"
import { missingEnvPlaceholders } from "../index"

describe("audit helpers", () => {
  test("missing auth storage does not crash env placeholder lookup", () => {
    const original = process.env.CLOUDFLARE_ACCOUNT_ID
    delete process.env.CLOUDFLARE_ACCOUNT_ID

    try {
      const model = {
        provider: "cloudflare-workers-ai",
        id: "@cf/moonshotai/kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
        input: ["text"],
        reasoning: true,
        contextWindow: 262144,
        maxTokens: 262144,
      }

      const ctx = {
        modelRegistry: {
          authStorage: undefined,
          hasConfiguredAuth: () => false,
          getProviderAuthStatus: () => ({ configured: false, source: undefined, label: undefined }),
          getAll: () => [],
          find: () => undefined,
        },
      } as any

      expect(missingEnvPlaceholders(model as any, ctx)).toEqual(["CLOUDFLARE_ACCOUNT_ID"])
    } finally {
      if (original !== undefined) {
        process.env.CLOUDFLARE_ACCOUNT_ID = original
      }
    }
  })
})
