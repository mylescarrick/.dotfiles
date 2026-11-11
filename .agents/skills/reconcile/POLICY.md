# Machine policy

How this Mac should be managed. Edit this file to change the agent's defaults.

## Defaults

- **Something installed on purpose belongs in the repo.** If the user installed
  a skill by hand, the default is to absorb it.
- **Vendored skills track upstream.** A `skills update -g` result is absorbed.
  For app-managed sources that are explicitly listed below, an update may be
  absorbed when the current skill exactly matches a tree at its configured
  upstream path. Update only `skillFolderHash` in `skills/lock.json` to that
  verified upstream tree. If it does not match, do not bless it as upstream;
  explain the mismatch and let the user choose another path.
  Other vendored skill edits are not absorbed; the fix goes upstream or into a
  local overlay skill (see `harness-routing`).

### App-managed vendored sources

- `https://github.com/stablyai/orca.git` owns and auto-updates `orca-cli` and
  `orchestration`. On **Add**, verify each changed skill against its own
  `skillPath` at the source's current upstream revision. If it matches, update
  that skill's lock hash and absorb it. Never copy the home directory into the
  repo or treat a non-matching edit as an upstream update.
- **Local skills are owned here.** Edits made in `~/.agents/skills` are
  absorbed, since editing in place is the normal way to change them now.
- **Experiments stay out.** Names starting with `tmp-`, `test-` or `scratch-`
  default to leaving as drift.
- **Work-only skills stay out.** Anything mentioning internal Knox systems,
  credentials, tenant IDs or customer data must not be committed. Recommend
  leaving it, and say why.

## Dotfiles

- **An edit to a managed dotfile is usually deliberate.** Default to absorbing it.
- **Secrets never enter the repo.** A token, API key or password inline in a shell file,
  git config or any other dotfile means: do not copy that file. Say which line, and
  suggest `secrets.zsh`.
- **Tool-managed files nag.** If a file changes every time a tool runs (a lock or
  session file), recommend untracking it from `home/` instead of absorbing each change.

## Homebrew packages

- **Declared means wanted on every machine.** Absorb a formula or cask the user
  installed on purpose. Do not absorb build dependencies someone pulled in to
  try something; ask when the name looks like a library rather than a tool.
- **Work-only tools stay out.** Same rule as skills: nothing that names internal
  Knox systems or customers.
- **Casks need admin to install.** Mention it when absorbing one, since every
  other machine will need elevation to converge.

## Bun and Pi packages

- **Same rule as Homebrew.** A global Bun package or Pi package installed on purpose
  belongs in the repo; a package pulled in to try something does not.
- **Pi packages run code inside the agent.** Before absorbing one, say who publishes it
  and when it was last updated, so the user is choosing with that in front of them.
- **A package the repo used to declare is a removal, not a new install.** Recommend
  uninstalling it, never re-adding it.

## Skill quality bar

Before absorbing a new local skill, check it against
`docs/skills-maintenance.md`: front-loaded description, distinct triggers,
harness-aware wording. Mention gaps; do not rewrite the skill unless asked.
