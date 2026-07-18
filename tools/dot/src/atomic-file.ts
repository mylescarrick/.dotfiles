import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AtomicFileOptions {
  readonly mode?: number;
  readonly sync?: boolean;
}

export async function replaceFileAtomic(
  path: string,
  content: string,
  options: AtomicFileOptions = {},
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${path.split("/").at(-1)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", options.mode ?? 0o666);
    await handle.writeFile(content, "utf8");
    if (options.sync) await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.mode !== undefined) await chmod(temporary, options.mode);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
