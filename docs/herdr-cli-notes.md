# Herdr CLI Notes

Verified against Homebrew `herdr 0.7.3` on 2026-07-11.

## Install

```sh
brew install herdr
```

## Relevant commands

### Version

```sh
herdr --version
# herdr 0.7.3
```

### Server

```text
herdr server                run as headless server
herdr server stop           stop the running server via the API socket
herdr server live-handoff   hand off live panes to a new local server
herdr server reload-config  reload config.toml in the running server
herdr server agent-manifests [--json]
herdr server update-agent-manifests [--json]
herdr server reload-agent-manifests
```

When no server is running, `herdr agent list` exits non-zero with:

```text
Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }
```

The Pi extension starts a detached server with:

```sh
nohup herdr server >/tmp/pi-herdr-server.log 2>&1 &
```

Then polls `herdr agent list` until the server responds.

### Agents

```text
herdr agent list
herdr agent get <target>
herdr agent read <target> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi] [--ansi]
herdr agent send <target> <text>
herdr agent rename <target> <name>|--clear
herdr agent focus <target>
herdr agent wait <target> --status <idle|working|blocked|unknown> [--timeout MS]
herdr agent attach <target> [--takeover]
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down] [--env KEY=VALUE] [--focus|--no-focus] -- <argv...>
herdr agent explain <target> [--json]
herdr agent explain --file PATH --agent LABEL [--json]
```

Targets accept terminal ids, unique agent names, detected/reported agent labels, and legacy pane ids.

Important detail: `herdr agent send` writes literal text. Use pane commands when command text plus Enter is needed.

### Panes

```text
herdr pane list [--workspace <workspace_id>]
herdr pane read <pane_id> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi] [--ansi]
herdr pane split [<pane_id>|--pane ID|--current] --direction right|down [--ratio FLOAT] [--cwd PATH] [--env KEY=VALUE] [--focus] [--no-focus]
herdr pane send-text <pane_id> <text>
herdr pane send-keys <pane_id> <key> [key ...]
herdr pane run <pane_id> <command>
```

The extension uses `agent` commands first because they preserve agent names and status semantics.

### Integrations

```text
herdr integration install pi
herdr integration uninstall pi
herdr integration status [--outdated-only]
```

`herdr integration install pi` writes Herdr's bundled Pi extension to:

```text
~/.pi/agent/extensions/herdr-agent-state.ts
```

If `PI_CODING_AGENT_DIR` is set, Herdr writes to `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`.

## Extension command strategy

Launch a child Pi worker with:

```sh
herdr agent start <name> \
  --cwd <cwd> \
  --split right \
  --no-focus \
  --env PI_HERDR_CHILD=1 \
  --env PI_HERDR_ROLE=<role> \
  -- \
  pi --name <name> [--provider P --model M --thinking L] [--tools read,grep,find,ls] '<prompt>'
```

Read output with:

```sh
herdr agent read <name> --source recent --lines 80 --format text
```

Wait with:

```sh
herdr agent wait <name> --status idle --timeout 120000
```
