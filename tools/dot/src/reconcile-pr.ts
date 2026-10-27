import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrewDriftItem } from "./brew-drift";
import type { DriftItem } from "./skill-drift";
import { hashDirectory } from "./tree-hash";

export type AnyDriftItem = BrewDriftItem | DriftItem;

const BREW_KEYWORD = { cask: "cask", formula: "brew", tap: "tap" } as const;

async function readOrEmpty(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

async function skillIsCovered(worktree: string, item: DriftItem): Promise<boolean> {
  const lock = JSON.parse((await readOrEmpty(join(worktree, "skills/lock.json"))) || "{}") as {
    skills?: Record<string, { skillFolderHash?: string }>;
  };
  const locked = lock.skills?.[item.name]?.skillFolderHash;
  const local = join(worktree, "skills/local", item.name);
  switch (item.kind) {
    case "vendored-added":
    case "vendored-updated":
      return locked !== undefined && locked === item.globalLockEntry?.skillFolderHash;
    case "deleted-locally":
      return !(locked || (await exists(local)));
    default:
      return (await exists(local)) && (await hashDirectory(local)) === item.currentHash;
  }
}

/**
 * Which reported items the agent's commits actually settle, read from the branch itself.
 * Items the user skipped are not covered, so they are asked about again next time.
 */
export async function coveredItems<T extends AnyDriftItem>(
  worktree: string,
  items: readonly T[]
): Promise<T[]> {
  const bundle = await readOrEmpty(join(worktree, "packages/bundle"));
  const covered: T[] = [];
  for (const item of items) {
    if (item.domain === "brew") {
      const name = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^\\s*${BREW_KEYWORD[item.package]}\\s+"${name}"`, "m").test(bundle)) covered.push(item);
    } else if (await skillIsCovered(worktree, item)) {
      covered.push(item);
    }
  }
  return covered;
}

function bullet(item: AnyDriftItem): string {
  const name = `\`${item.name}\``;
  if (item.domain === "brew") {
    const caution = item.package === "cask" ? " Casks need admin rights to install." : "";
    return `**Declare ${name} in the Brewfile.** It is installed with Homebrew on this Mac but missing from \`packages/bundle\`, so other machines would not get it.${caution}`;
  }
  const pin = (item.globalLockEntry ? item.globalLockEntry.skillFolderHash : "").slice(0, 7);
  switch (item.kind) {
    case "added-locally":
      return `**Add the ${name} skill.** Written on this Mac; now in \`skills/local/${item.name}\`.`;
    case "vendored-added":
      return `**Track the ${name} skill.** Installed here with the skills CLI; pinned at \`${pin}\` in \`skills/lock.json\`.`;
    case "vendored-updated":
      return `**Update the ${name} skill to \`${pin}\`.** Updated on this Mac with the skills CLI; the repo still pinned the old version.`;
    case "deleted-locally":
      return `**Remove the ${name} skill.** Deleted on this Mac but still in the repo.`;
    default:
      return `**Take this Mac's edits to the ${name} skill.** It was changed here after the repo's version.`;
  }
}

/** Title and body for the PR, built from the covered items so it never depends on how the agent worded its commit. */
export function renderPullRequest(
  covered: readonly AnyDriftItem[],
  subjects: readonly string[]
): { readonly body: string; readonly title: string } {
  const title =
    subjects.length === 1 && subjects[0]
      ? subjects[0]
      : `chore: absorb ${covered.length} difference(s) from this Mac`;
  const body = `## Summary

${covered.map((item) => `- ${bullet(item)}`).join("\n")}

Opened by \`dot reconcile\`, from differences between this Mac and the repo.

## Test plan

- [ ] The diff only touches \`skills/\` and \`packages/bundle\`
- [ ] After merging, \`dot\` on this Mac no longer reports ${covered.length === 1 ? "this item" : "these items"} as drift
`;
  return { body, title };
}
