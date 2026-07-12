#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir/.dotfiles"
cp "$repo_root/dot" "$tmp_dir/.dotfiles/dot"
chmod +x "$tmp_dir/.dotfiles/dot"

HOME="$tmp_dir" "$tmp_dir/.dotfiles/dot" pi-auth cloudflare \
  --non-interactive \
  --account-id test-account \
  --gateway-id test-gateway \
  --api-key-op-ref "op://Vault/Cloudflare/credential" \
  >"$tmp_dir/pi-auth.log" 2>&1

auth_file="$tmp_dir/.pi/agent/auth.json"
[[ -f "$auth_file" ]]
[[ "$(stat -f '%Lp' "$auth_file")" == "600" ]]

AUTH_FILE="$auth_file" node <<'NODE'
const fs = require('fs');
const auth = JSON.parse(fs.readFileSync(process.env.AUTH_FILE, 'utf8'));
const gateway = auth['cloudflare-ai-gateway'];
const workers = auth['cloudflare-workers-ai'];
if (!gateway || !workers) throw new Error('missing Cloudflare providers');
if (gateway.type !== 'api_key' || workers.type !== 'api_key') throw new Error('wrong credential type');
if (gateway.key !== "!op read 'op://Vault/Cloudflare/credential'") throw new Error('wrong gateway key');
if (workers.key !== "!op read 'op://Vault/Cloudflare/credential'") throw new Error('wrong workers key');
if (gateway.env.CLOUDFLARE_ACCOUNT_ID !== 'test-account') throw new Error('wrong gateway account');
if (gateway.env.CLOUDFLARE_GATEWAY_ID !== 'test-gateway') throw new Error('wrong gateway id');
if (workers.env.CLOUDFLARE_ACCOUNT_ID !== 'test-account') throw new Error('wrong workers account');
NODE

if HOME="$tmp_dir" "$tmp_dir/.dotfiles/dot" pi-auth cloudflare --non-interactive >"$tmp_dir/pi-auth-missing.log" 2>&1; then
  echo "expected non-interactive pi-auth without account/gateway to fail" >&2
  exit 1
fi

echo "pi-auth cloudflare test passed"
