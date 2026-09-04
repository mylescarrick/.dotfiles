# pi-safety-guard

A global Pi extension that confirms high-risk **agent** tool calls and provides value-safe dotenv key checks.

## Guarantees

- `read`, `write`, and `edit` of protected secret paths require interactive approval. They are blocked in non-interactive modes.
- Destructive agent Bash commands and direct Bash access to common secret files require interactive approval. They are blocked in non-interactive modes.
- `env_check_keys` reads only `.env` or `.env.<name>` files and returns presence or absence for the explicitly requested keys. It never returns values or file contents.
- Approvals are exact and session-only. Use `/safety-guard clear` to revoke them.

## Limits

This is not a sandbox. It cannot reliably constrain unknown custom or MCP tools, and Bash detection is intentionally conservative. Use a minimal environment and filesystem isolation when secrets must be inaccessible to Pi.

## Commands

```text
/safety-guard          # show active session approvals
/safety-guard clear    # revoke all session approvals
```
