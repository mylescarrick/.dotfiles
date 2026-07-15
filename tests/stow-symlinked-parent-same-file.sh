#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/.dotfiles/home/.agents/skills/foo"
mkdir -p "$tmp_dir/.dotfiles/home/.config/ghostty"
cp "$repo_root/dot" "$tmp_dir/.dotfiles/dot"
chmod +x "$tmp_dir/.dotfiles/dot"

cat > "$tmp_dir/.dotfiles/home/.agents/skills/foo/SKILL.md" <<'EOF'
---
name: foo
description: Test skill
---

# Foo
EOF

cat > "$tmp_dir/.dotfiles/home/.config/ghostty/config" <<'EOF'
theme = test
EOF

# Simulate an already-stowed/folded parent path. The child file path under
# $HOME resolves back to the tracked source file, but the child path itself is
# not a symlink. The conflict preflight must skip it, not `rm` it as an
# identical live file.
mkdir -p "$tmp_dir/.agents/skills"
ln -s ../../.dotfiles/home/.agents/skills/foo "$tmp_dir/.agents/skills/foo"
mkdir -p "$tmp_dir/.config"
ln -s ../.dotfiles/home/.config/ghostty "$tmp_dir/.config/ghostty"

source_skill="$tmp_dir/.dotfiles/home/.agents/skills/foo/SKILL.md"
target_skill="$tmp_dir/.agents/skills/foo/SKILL.md"
source_config="$tmp_dir/.dotfiles/home/.config/ghostty/config"
target_config="$tmp_dir/.config/ghostty/config"

[[ "$source_skill" -ef "$target_skill" ]]
[[ "$source_config" -ef "$target_config" ]]

HOME="$tmp_dir" "$tmp_dir/.dotfiles/dot" stow >"$tmp_dir/stow.log" 2>&1

[[ -f "$source_skill" ]]
[[ -f "$target_skill" ]]
[[ "$(cat "$source_skill")" == "$(cat "$target_skill")" ]]
[[ -f "$source_config" ]]
[[ -f "$target_config" ]]
[[ "$(cat "$source_config")" == "$(cat "$target_config")" ]]

if grep -q 'Removed .* identical live file' "$tmp_dir/stow.log"; then
  echo "same-file target was incorrectly treated as an identical live file" >&2
  cat "$tmp_dir/stow.log" >&2
  exit 1
fi

echo "stow symlinked parent same-file regression passed"
