---
name: mc-commit
description: ALWAYS use this skill when creating git commits. Follows conventional commit standards with scope detection and secret awareness. Trigger on any commit, stage and commit, save changes, checkpoint, or request to commit work.
---

# MC Commit

Create commits following conventional commit standards.

## Process

### 1. Pre-flight

```bash
git status --porcelain        # anything to commit?
git branch --show-current     # on main/master? ask whether to branch first
```

### 2. Analyze & Stage

```bash
git status --porcelain
git diff --stat HEAD
git diff --name-only HEAD
git log --oneline -5
```

- Identify which top-level areas are touched (directory names, packages, or modules) and the type of change
- Read full diffs only for files you need to classify or stage safely
- **Never commit**: `.env`, `.dev.vars`, `credentials.json`, `*.pem`, private keys, or anything matching a gitignored secrets file (e.g. `secrets.zsh`) — warn if present and unstage it
- Prefer explicit path staging (`git add <files>`)
- Use `git add -A` only after confirming every changed path belongs in the same commit
- If changes are mixed, make multiple commits by staging coherent path groups; after each commit, re-run `git status --porcelain` and continue until clean

### 3. Compose the Message

```
<type>(<scope>): <subject>

<body — optional, explain why>
```

**Types**: `feat` · `fix` · `refactor` · `docs` · `chore` · `test` · `ci` · `perf` · `style`

**Scope**: the top-level directory or module the change is concentrated in (e.g. `git`, `fish`, `dot`, `packages`, `docs`). Omit scope for genuinely cross-cutting changes.

**Subject**: imperative mood, lowercase after colon, no period, max ~70 chars total.

**Body**: explain motivation/what was wrong, not what the diff already shows. Use real newlines, never literal `\n`.

Never include AI attribution footers unless the user explicitly asks.

### 4. Commit & Verify

Before each commit:

```bash
git diff --cached --stat
git diff --cached --check   # catches trailing whitespace / conflict markers
```

Run whatever cheap verification actually applies to what changed — e.g. `bash -n <script>` for a touched shell script, `npm run typecheck`/`lint` if a `package.json` defines them and JS/TS files changed. Skip verification that clearly doesn't apply; don't invent checks the project doesn't have. If a verification step already ran this session against the currently staged changes with nothing since, don't re-run it — just mention it already passed.

```bash
git commit -F <(cat <<'EOF'
type(scope): subject line here

Optional body explaining why.
EOF
)

git status --porcelain        # confirm clean tree or continue staged groups
git log -1 --format="%B"      # verify message
```

Prefer writing multi-line messages to a temp file and using `git commit -F <file>` over inline heredocs — commit bodies containing backticks, `$`, or quotes are easy to break with inline shell interpolation.

## Examples

```
feat(dot): add oh-my-zsh bootstrap to init tool registry

Fish is no longer the managed shell; dot init should be able to set
up oh-my-zsh on a fresh machine the same way it used to set up fish.
```

```
fix(git): stop fomo/lg aliases shelling out to fish

Both aliases called `fish -c ...`, which no longer exists now that
the shell is zsh. Rewrote fomo as a self-contained sh one-liner since
git `!` aliases don't run in the interactive shell's rc files.
```

```
chore(packages): drop fish and fisher from the base bundle
```

## Principles

- One coherent change per commit; the repo should be in a working state after each
- If current branch is `main`/`master`, ask whether to create a branch first; suggest `<scope>/<short-topic>`
- Explain **why**, not just **what**
- Never skip pre-commit hooks (`--no-verify`)
