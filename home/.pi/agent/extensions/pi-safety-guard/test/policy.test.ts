import assert from "node:assert/strict";
import test from "node:test";
import { checkEnvKeys, isProtectedPath, resolveSafeEnvPath } from "../policy.ts";

test("safety guard protects secret files while leaving ordinary project files available", () => {
  assert.equal(isProtectedPath(".env", "/project"), true);
  assert.equal(isProtectedPath("config/.env.production", "/project"), true);
  assert.equal(isProtectedPath("~/.ssh/id_ed25519", "/project"), true);
  assert.equal(isProtectedPath("src/index.ts", "/project"), false);
});

test("safety guard accepts only dotenv files for value-safe key checks", () => {
  assert.equal(resolveSafeEnvPath(".env", "/project"), "/project/.env");
  assert.equal(resolveSafeEnvPath("config/.env.local", "/project"), "/project/config/.env.local");
  assert.equal(resolveSafeEnvPath("secrets.txt", "/project"), undefined);
});

test("safety guard reports only requested dotenv key presence without values", () => {
  assert.deepEqual(
    checkEnvKeys("# comment\nexport API_KEY=secret\nEMPTY=\nOTHER=value\n", ["API_KEY", "EMPTY", "MISSING"]),
    [
      { key: "API_KEY", present: true },
      { key: "EMPTY", present: true },
      { key: "MISSING", present: false },
    ]
  );
});
