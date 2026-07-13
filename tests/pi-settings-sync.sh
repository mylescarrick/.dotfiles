#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/.dotfiles/config/pi" "$tmp_dir/.pi/agent"
cp "$repo_root/dot" "$tmp_dir/.dotfiles/dot"
chmod +x "$tmp_dir/.dotfiles/dot"
cp "$repo_root/config/pi/settings.defaults.json" "$tmp_dir/.dotfiles/config/pi/settings.defaults.json"

cat > "$tmp_dir/.pi/agent/settings.json" <<'JSON'
{
  "defaultProvider": "claude-bridge",
  "defaultModel": "claude-opus-4-8",
  "defaultThinkingLevel": "medium",
  "lastChangelogVersion": "0.80.6",
  "packages": ["runtime-owned-package"]
}
JSON

HOME="$tmp_dir" "$tmp_dir/.dotfiles/dot" pi-settings sync >"$tmp_dir/pi-settings.log" 2>&1

AUTH_FILE="$tmp_dir/.pi/agent/settings.json" node <<'NODE'
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync(process.env.AUTH_FILE, 'utf8'));
if (settings.theme !== 'dark') throw new Error('missing tracked theme default');
if (settings.defaultProvider !== 'claude-bridge') throw new Error('runtime provider was not preserved');
if (settings.defaultModel !== 'claude-opus-4-8') throw new Error('runtime model was not preserved');
if (settings.defaultThinkingLevel !== 'medium') throw new Error('runtime thinking level was not preserved');
if (settings.lastChangelogVersion !== '0.80.6') throw new Error('runtime changelog version was not preserved');
if (!Array.isArray(settings.packages) || settings.packages.includes('runtime-owned-package')) {
  throw new Error('packages should come from tracked defaults');
}
if (!settings.packages.includes('npm:pi-claude-bridge')) throw new Error('missing tracked package');
NODE

# Migration: replace an old stowed settings symlink with a real runtime file.
mkdir -p "$tmp_dir/.dotfiles/home/.pi/agent"
cat > "$tmp_dir/.dotfiles/home/.pi/agent/settings.json" <<'JSON'
{"defaultProvider":"github-copilot","packages":["old"]}
JSON
rm -f "$tmp_dir/.pi/agent/settings.json"
ln -s "../../.dotfiles/home/.pi/agent/settings.json" "$tmp_dir/.pi/agent/settings.json"
HOME="$tmp_dir" "$tmp_dir/.dotfiles/dot" pi-settings sync >"$tmp_dir/pi-settings-symlink.log" 2>&1
[[ ! -L "$tmp_dir/.pi/agent/settings.json" ]]

echo "pi-settings sync test passed"
