import { describe, expect, test } from "bun:test";
import { checkBash, checkWritePath } from "../../../.pi/extensions/reconcile-guard/policy";

const WT = "/Users/me/.dotfiles-worktrees/reconcile-1";

describe("reconcile guard: commands the agent legitimately needs", () => {
  test.each([
    "git status --porcelain",
    "git add -A && git commit -F /tmp/msg.txt",
    "git log -S'typst' --oneline -- packages/bundle",
    "git rm home/.zshrc",
    "git -C /Users/me/.dotfiles-worktrees/reconcile-1 diff --stat",
    "diff -ru skills/local/tdd ~/.agents/skills/tdd",
    "rsync -a --delete ~/.agents/skills/tdd/ skills/local/tdd/",
    "cp ~/.zshrc home/.zshrc",
    "mkdir -p skills/local/new-skill",
    "sed -n 1,20p ~/.zshrc",
    "cat ~/.config/ghostty/config | head -5",
    "echo hi > /tmp/commit-msg.txt",
    "ls ~/.agents/skills && bun --version",
  ])("allows %s", (command) => {
    expect(checkBash(command, WT)).toBeUndefined();
  });
});

describe("reconcile guard: things it must not do", () => {
  test.each([
    ["git push origin HEAD", "dot pushes"],
    ["git remote set-url origin x", "dot pushes"],
    ["git commit --no-verify -m x", "scans must run"],
    ["gh pr create --fill", "dot pushes"],
    ["sudo rm -rf /", "elevated"],
    ["brew install typst", "installed"],
    ["brew upgrade", "installed"],
    ["bun add -g wrangler", "installed"],
    ["npm install --global x", "installed"],
    ["pi install npm:x", "installed"],
    ["bunx skills add -g x/y", "installed"],
    ["dot apply", "after you finish"],
    ["dot drift restore .zshrc", "after you finish"],
    ["echo ok && git push", "dot pushes"],
  ])("blocks %s", (command, because) => {
    expect(checkBash(command, WT)).toContain(because);
  });

  test.each([
    "rm ~/.zshrc",
    "rm -rf ~/.config/ghostty",
    "mv home/.zshrc ~/.zshrc",
    "cp home/.zshrc ~/.zshrc",
    "rsync -a skills/local/x/ ~/.agents/skills/x/",
    "echo x > ~/.zshrc",
    "echo x >> /Users/me/.ssh/config",
    "sed -i '' 's/a/b/' ~/.zshrc",
    "tee ~/.zshrc",
    "git -C /Users/me/.dotfiles checkout main",
    "ln -s a ~/b",
    "mkdir -p ~/.local/new",
  ])("blocks a write outside the worktree: %s", (command) => {
    expect(checkBash(command, WT)).toContain("outside the worktree");
  });
});

describe("reconcile guard: file tools", () => {
  test("allows the worktree and temp files, blocks the rest", () => {
    expect(checkWritePath(`${WT}/skills/local/x/SKILL.md`, WT)).toBeUndefined();
    expect(checkWritePath("skills/local/x/SKILL.md", WT)).toBeUndefined();
    expect(checkWritePath("/tmp/commit-msg.txt", WT)).toBeUndefined();
    expect(checkWritePath("/Users/me/.zshrc", WT)).toContain("outside the worktree");
    expect(checkWritePath("~/.zshrc", WT)).toContain("outside the worktree");
    expect(checkWritePath(`${WT}/../reconcile-2/x`, WT)).toContain("outside the worktree");
  });
});
