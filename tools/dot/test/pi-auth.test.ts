import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
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
        github: { type: "oauth", token: "preserve" },
        "cloudflare-ai-gateway": {
          type: "api_key",
          key: "$OLD_KEY",
          env: { PRESERVE_ME: "yes" },
        },
      })}\n`,
      { mode: 0o644 },
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
      stdout: "Pi Cloudflare auth configured\n",
      stderr: "",
    });
    expect(outcome.stdout).not.toContain(reference);
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    expect(auth.github).toEqual({ type: "oauth", token: "preserve" });
    expect(auth["cloudflare-ai-gateway"]).toEqual({
      type: "api_key",
      key: `!op read '${reference}'`,
      env: {
        PRESERVE_ME: "yes",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_GATEWAY_ID: "gateway",
      },
    });
    expect(auth["cloudflare-workers-ai"]).toEqual({
      type: "api_key",
      key: `!op read '${reference}'`,
      env: { CLOUDFLARE_ACCOUNT_ID: "account" },
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
      argv: [
        "pi",
        "auth",
        "cloudflare",
        "--account-id",
        "account",
        "--gateway-id",
        "gateway",
      ],
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
      argv: [
        "pi",
        "auth",
        "cloudflare",
        "--account-id",
        "--gateway-id",
      ],
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
