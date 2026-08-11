import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readExaApiKeyRef, resolveExaApiKeyCached } from "../exa-auth.ts";

async function withAgentDir(auth: unknown, run: () => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "web-tools-exa-auth-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(root, { recursive: true });
    if (auth !== undefined) {
      await writeFile(join(root, "web-tools-auth.json"), JSON.stringify(auth));
    }
    process.env.PI_CODING_AGENT_DIR = root;
    await run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
}

test("readExaApiKeyRef returns undefined when no auth file exists", async () => {
  await withAgentDir(undefined, () => {
    assert.equal(readExaApiKeyRef(), undefined);
  });
});

test("readExaApiKeyRef returns undefined for malformed JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-tools-exa-auth-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await writeFile(join(root, "web-tools-auth.json"), "{ not json");
    process.env.PI_CODING_AGENT_DIR = root;
    assert.equal(readExaApiKeyRef(), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test("readExaApiKeyRef reads the configured exa key reference", async () => {
  await withAgentDir({ exa: { key: "!op read 'op://vault/item/field'", type: "api_key" } }, () => {
    assert.equal(readExaApiKeyRef(), "!op read 'op://vault/item/field'");
  });
});

test("resolveExaApiKeyCached resolves a literal reference", async () => {
  assert.equal(await resolveExaApiKeyCached("literal-value-a"), "literal-value-a");
});

test("resolveExaApiKeyCached resolves an environment variable reference", async () => {
  process.env.WEB_TOOLS_TEST_EXA_KEY = "env-value-a";
  try {
    assert.equal(await resolveExaApiKeyCached("$WEB_TOOLS_TEST_EXA_KEY"), "env-value-a");
  } finally {
    delete process.env.WEB_TOOLS_TEST_EXA_KEY;
  }
});

test("resolveExaApiKeyCached resolves a shell command reference", async () => {
  assert.equal(await resolveExaApiKeyCached("!echo shell-value-a"), "shell-value-a");
});

test("resolveExaApiKeyCached only runs the resolver command once per distinct reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-tools-exa-auth-"));
  const counterPath = join(root, "count");
  try {
    const ref = `!echo x >> '${counterPath}' && echo cached-value-b`;
    const first = await resolveExaApiKeyCached(ref);
    const second = await resolveExaApiKeyCached(ref);
    assert.equal(first, "cached-value-b");
    assert.equal(second, "cached-value-b");
    assert.equal((await readFile(counterPath, "utf8")).trim(), "x");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
