import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dot-pi-auth-"));
  temporaryDirectories.push(path);
  return path;
}

describe("Pi Cloudflare auth", () => {
  test("preserves providers and environment while formatting an op resolver", async () => {
    const root = await home();
    const authPath = join(root, ".pi/agent/auth.json");
    await mkdir(join(root, ".pi/agent"), { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify({
        "cloudflare-ai-gateway": {
          env: { PRESERVE_ME: "yes" },
          key: "$OLD_KEY",
          type: "api_key",
        },
        github: { token: "preserve", type: "oauth" },
      })}\n`,
      { mode: 0o644 }
    );
    const reference = "op://Private/Cloudflare Pi API Token/credential";

    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: [
        "pi",
        "auth",
        "cloudflare",
        "--account-id",
        "account",
        "--gateway-id",
        "gateway",
        "--api-key-op-ref",
        reference,
      ],
      cwd: "/unused",
      env: { HOME: root },
    });

    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Pi Cloudflare auth configured\n",
    });
    expect(outcome.stdout).not.toContain(reference);
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth.github).toEqual({ token: "preserve", type: "oauth" });
    expect(auth["cloudflare-ai-gateway"]).toEqual({
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_GATEWAY_ID: "gateway",
        PRESERVE_ME: "yes",
      },
      key: `!op read '${reference}'`,
      type: "api_key",
    });
    expect(auth["cloudflare-workers-ai"]).toEqual({
      env: { CLOUDFLARE_ACCOUNT_ID: "account" },
      key: `!op read '${reference}'`,
      type: "api_key",
    });
    expect((await lstat(authPath)).mode & 0o777).toBe(0o600);
  });

  test("uses an environment resolver without reading its secret", async () => {
    const root = await home();
    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: [
        "pi",
        "auth",
        "cloudflare",
        "--account-id",
        "account",
        "--gateway-id",
        "gateway",
        "--api-key-env",
        "PRIVATE_CF_KEY",
      ],
      cwd: "/unused",
      env: { HOME: root, PRIVATE_CF_KEY: "must-not-be-read-or-logged" },
    });

    expect(outcome.stdout + outcome.stderr).not.toContain("must-not-be-read-or-logged");
    const auth = JSON.parse(await readFile(join(root, ".pi/agent/auth.json"), "utf8"));
    expect(auth["cloudflare-ai-gateway"].key).toBe("$PRIVATE_CF_KEY");
  });

  test("invalid JSON is preserved", async () => {
    const root = await home();
    const authPath = join(root, ".pi/agent/auth.json");
    await mkdir(join(root, ".pi/agent"), { recursive: true });
    await writeFile(authPath, "{ invalid\n", { mode: 0o640 });

    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "cloudflare", "--account-id", "account", "--gateway-id", "gateway"],
      cwd: "/unused",
      env: { HOME: root },
    });

    expect(outcome).toMatchObject({ exitCode: 1, stderr: "dot: Pi auth contains invalid JSON\n" });
    expect(await readFile(authPath, "utf8")).toBe("{ invalid\n");
    expect((await lstat(authPath)).mode & 0o777).toBe(0o640);
  });

  test("rejects a flag in a value position before touching auth", async () => {
    const root = await home();
    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "cloudflare", "--account-id", "--gateway-id"],
      cwd: "/unused",
      env: { HOME: root },
    });
    expect(outcome.exitCode).toBe(2);
    expect(await Bun.file(join(root, ".pi/agent/auth.json")).exists()).toBe(false);
  });

  test("rejects incomplete option pairs before touching auth", async () => {
    const root = await home();
    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "cloudflare", "--account-id"],
      cwd: "/unused",
      env: { HOME: root },
    });
    expect(outcome.exitCode).toBe(2);
    expect(await Bun.file(join(root, ".pi/agent/auth.json")).exists()).toBe(false);
  });
});

describe("Pi Exa auth", () => {
  test("writes an op resolver to a private web-tools auth file", async () => {
    const root = await home();
    const reference = "op://jhqkujv2uad3mk5izxfnl2tdki/Exa Agentic Search/API_KEY";

    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "exa", "--api-key-op-ref", reference],
      cwd: "/unused",
      env: { HOME: root },
    });

    expect(outcome).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Exa search auth configured\n",
    });
    expect(outcome.stdout).not.toContain(reference);
    const authPath = join(root, ".pi/agent/web-tools-auth.json");
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth.exa).toEqual({ key: `!op read '${reference}'`, type: "api_key" });
    expect((await lstat(authPath)).mode & 0o777).toBe(0o600);
  });

  test("defaults to the EXA_API_KEY environment resolver without reading its secret", async () => {
    const root = await home();
    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "exa"],
      cwd: "/unused",
      env: { EXA_API_KEY: "must-not-be-read-or-logged", HOME: root },
    });

    expect(outcome.stdout + outcome.stderr).not.toContain("must-not-be-read-or-logged");
    const auth = JSON.parse(await readFile(join(root, ".pi/agent/web-tools-auth.json"), "utf8"));
    expect(auth.exa).toEqual({ key: "$EXA_API_KEY", type: "api_key" });
  });

  test("preserves unrelated web-tools auth entries", async () => {
    const root = await home();
    const authPath = join(root, ".pi/agent/web-tools-auth.json");
    await mkdir(join(root, ".pi/agent"), { recursive: true });
    await writeFile(authPath, `${JSON.stringify({ other: { keep: true } })}\n`, { mode: 0o644 });

    await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "exa", "--api-key-env", "EXA_API_KEY"],
      cwd: "/unused",
      env: { HOME: root },
    });

    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth.other).toEqual({ keep: true });
    expect(auth.exa).toEqual({ key: "$EXA_API_KEY", type: "api_key" });
  });

  test("rejects choosing two key sources", async () => {
    const root = await home();
    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: [
        "pi",
        "auth",
        "exa",
        "--api-key-env",
        "EXA_API_KEY",
        "--api-key-op-ref",
        "op://vault/item/field",
      ],
      cwd: "/unused",
      env: { HOME: root },
    });
    expect(outcome).toEqual({
      exitCode: 2,
      stderr: "dot: choose one Exa API key source\n",
      stdout: "",
    });
    expect(await Bun.file(join(root, ".pi/agent/web-tools-auth.json")).exists()).toBe(false);
  });

  test("rejects incomplete option pairs before touching auth", async () => {
    const root = await home();
    const outcome = await createApplication({ checkoutRoot: "/unused" }).execute({
      argv: ["pi", "auth", "exa", "--api-key-env"],
      cwd: "/unused",
      env: { HOME: root },
    });
    expect(outcome.exitCode).toBe(2);
    expect(await Bun.file(join(root, ".pi/agent/web-tools-auth.json")).exists()).toBe(false);
  });
});
