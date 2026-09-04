import assert from "node:assert/strict";
import test from "node:test";
import { checkEnvKeys, classifyBashCommand, isProtectedPath, resolveSafeEnvPath } from "../policy.ts";

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

for (const command of [
  "rm -rf build",
  "git reset --hard HEAD~1",
  "git clean -fd",
  "git push --force origin main",
  "docker system prune -af",
  "dd if=/dev/zero of=/dev/disk1",
]) {
  test(`safety guard requires confirmation for ${command}`, () => {
    assert.notEqual(classifyBashCommand(command), undefined);
  });
}

test("safety guard recognizes explicit long rm options", () => {
  assert.notEqual(classifyBashCommand("rm --recursive build"), undefined);
  assert.notEqual(classifyBashCommand("rm --force generated.txt"), undefined);
});

test("safety guard does not interrupt ordinary development commands", () => {
  assert.equal(classifyBashCommand("bun test"), undefined);
  assert.equal(classifyBashCommand("git status --short"), undefined);
  assert.equal(classifyBashCommand("rm --preserve-root generated.txt"), undefined);
});
