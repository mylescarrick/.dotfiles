import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

function parseObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function readRuntime(path: string): Promise<Record<string, unknown>> {
  try {
    return parseObject(await readFile(path, "utf8"), "Pi runtime settings");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function currentRegularFileMatches(
  path: string,
  desired: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) return false;
    return (await readFile(path, "utf8")) === desired;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function replacePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncPiSettings(options: {
  readonly checkoutRoot: string;
  readonly home: string;
}): Promise<boolean> {
  const defaultsPath = join(options.checkoutRoot, "config/pi/settings.defaults.json");
  const settingsPath = join(options.home, ".pi/agent/settings.json");

  let defaults: Record<string, unknown>;
  try {
    defaults = parseObject(
      await readFile(defaultsPath, "utf8"),
      "Tracked Pi settings defaults",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`tracked Pi settings defaults are missing at ${defaultsPath}`);
    }
    throw error;
  }

  const current = await readRuntime(settingsPath);
  const merged = { ...defaults, ...current };
  if (Object.hasOwn(defaults, "packages")) merged.packages = defaults.packages;
  const desired = `${JSON.stringify(merged, null, 2)}\n`;

  if (await currentRegularFileMatches(settingsPath, desired)) return false;
  await replacePrivateFile(settingsPath, desired);
  return true;
}
