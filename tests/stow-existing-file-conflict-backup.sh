#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/.dotfiles/home/.pi/agent"
cp "$repo_root/dot" "$tmp_dir/.dotfiles/dot"
chmod +x "$tmp_dir/.dotfiles/dot"

cat > "$tmp_dir/.dotfiles/home/.pi/agent/settings.json" <<'EOF'
{"tracked": true}
EOF

mkdir -p "$tmp_dir/.pi/agent"
cat > "$tmp_dir/.pi/agent/settings.json" <<'EOF'
{"live": true}
EOF

HOME="$tmp_dir" "$tmp_dir/.dotfiles/dot" stow >"$tmp_dir/stow.log" 2>&1

[[ -L "$tmp_dir/.pi/agent/settings.json" ]]
[[ "$(cat "$tmp_dir/.pi/agent/settings.json")" == '{"tracked": true}' ]]

backup_file="$(find "$tmp_dir/.dotfiles/backups/stow-conflicts" -path '*/.pi/agent/settings.json' -type f | head -1)"
[[ -n "$backup_file" ]]
[[ "$(cat "$backup_file")" == '{"live": true}' ]]

grep -q 'Backed up 1 existing live file' "$tmp_dir/stow.log"

echo "stow existing file conflict backup regression passed"
