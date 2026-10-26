import { createHash, type Hash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

export type Observed =
  | { readonly kind: "absent" }
  | { readonly kind: "directory"; readonly hash: string }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "other" };

const IGNORED_NAMES = new Set([".DS_Store"]);

/**
 * Hashes a directory by relative path, executable bit and content. Timestamps and
 * other mode bits are deliberately excluded so a fresh copy hashes the same as its source.
 */
async function hashEntry(hash: Hash, path: string, relative: string, isLink: boolean): Promise<void> {
  if (isLink) {
    hash.update(`l\0${relative}\0${await readlink(path)}\0`);
    return;
  }
  const executable = ((await lstat(path)).mode & 0o111) !== 0;
  const bytes = await readFile(path);
  hash.update(`f\0${relative}\0${executable ? "x" : "-"}\0${bytes.length}\0`);
  hash.update(bytes);
}

export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : Number(a.name > b.name)
    );
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, relative);
      else if (entry.isSymbolicLink() || entry.isFile())
        await hashEntry(hash, path, relative, entry.isSymbolicLink());
    }
  }
  await visit(root, "");
  return `sha256:${hash.digest("hex")}`;
}

export async function observe(path: string): Promise<Observed> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
    if (metadata.isDirectory()) return { hash: await hashDirectory(path), kind: "directory" };
    return { kind: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}
