# Machine policy

How this Mac should be managed. Edit this file to change the agent's defaults.

## Defaults

- **Something installed on purpose belongs in the repo.** If the user installed
  a skill by hand, the default is to absorb it.
- **Vendored skills track upstream.** A `skills update -g` result is absorbed.
  Local edits to vendored skill content are discarded; the fix goes upstream
  or into a local overlay skill (see `harness-routing`).
- **Local skills are owned here.** Edits made in `~/.agents/skills` are
  absorbed, since editing in place is the normal way to change them now.
- **Experiments stay out.** Names starting with `tmp-`, `test-` or `scratch-`
  default to leaving as drift.
- **Work-only skills stay out.** Anything mentioning internal Knox systems,
  credentials, tenant IDs or customer data must not be committed. Recommend
  leaving it, and say why.

## Homebrew packages

- **Declared means wanted on every machine.** Absorb a formula or cask the user
  installed on purpose. Do not absorb build dependencies someone pulled in to
  try something; ask when the name looks like a library rather than a tool.
- **Work-only tools stay out.** Same rule as skills: nothing that names internal
  Knox systems or customers.
- **Casks need admin to install.** Mention it when absorbing one, since every
  other machine will need elevation to converge.

## Skill quality bar

Before absorbing a new local skill, check it against
`docs/skills-maintenance.md`: front-loaded description, distinct triggers,
harness-aware wording. Mention gaps; do not rewrite the skill unless asked.
