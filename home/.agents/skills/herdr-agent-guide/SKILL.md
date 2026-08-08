---
name: herdr-agent-guide
description: "Guide a human through understanding, installing, configuring, or troubleshooting Herdr. Use when the user asks for help learning, setting up, or fixing Herdr, rather than asking the agent to operate Herdr."
---

# Herdr Agent Guide

Help humans learn, install, configure, and troubleshoot Herdr. Canonical documentation lives at https://herdr.dev/docs/. Verify any command or config key you are unsure of against those pages instead of guessing.

## What Herdr is

Herdr is a terminal workspace manager for AI coding agents. Like tmux, it is a multiplexer: a background server owns real terminal processes, and clients attach to render them. Panes keep running when the human detaches, closes the terminal, or disconnects SSH.

Unlike tmux, Herdr is mouse-first and agent-aware. The whole UI is clickable. Herdr detects coding agents running inside panes and shows each one's state in a sidebar.

## Concept model

Teach these in order:

- **Session** — a persistent background namespace. Running `herdr` attaches to the default session. Named sessions (`herdr session attach work`) are fully separate runtime namespaces.
- **Workspace** — the project-level container. Owns tabs and panes.
- **Tab** — a layout inside a workspace.
- **Pane** — a real terminal. Splittable right or down. Survives client detach.
- **Agent** — a process Herdr recognizes inside a pane. States: `working`, `blocked`, `done`, `idle`, `unknown`.
- **Modes** — terminal mode sends keys to the focused pane; prefix mode (`ctrl+b`, then one action key) sends one command to Herdr; navigate mode is a persistent navigation surface.

Full concepts: https://herdr.dev/docs/concepts/

## Install

Linux and macOS:

```bash
curl -fsSL https://herdr.dev/install.sh | sh
herdr
```

Windows preview beta:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
herdr
```

Homebrew, mise, Nix, verification, and manual downloads: https://herdr.dev/docs/install/

Updating later: `herdr update`. Check the version with `herdr --version`.

## First-run walkthrough

First check the environment. If `HERDR_ENV=1` is set, the human is already inside a Herdr pane — skip step 1 entirely and never tell them to run `herdr` from your pane. Herdr blocks nested launches by design.

1. `cd` into a project and run `herdr`. It launches or attaches to the default background session and creates a workspace automatically.
2. Start their coding agent in the pane (`claude`, `codex`, or any supported agent). Herdr detects it automatically. Installing the matching integration improves detection: `herdr integration install pi` (and similarly for other agents).
3. Show them the mouse first: click panes and tabs to focus, drag split borders, right-click for menus, drag-select to copy. No keybindings are required.
4. Split panes with right-click or `prefix+v` (right) / `prefix+minus` (down). New tab: `prefix+c`.
5. Detach with `prefix+q` (press `ctrl+b`, release, press `q`) or close the terminal window. Reattach later with `herdr`.
6. Stop everything: `herdr server stop`.

Supported agents and integrations: https://herdr.dev/docs/agents/ and https://herdr.dev/docs/integrations/

## The keyboard story

Important framing: Herdr does not require learning keybindings. The mouse covers everything.

- The prefix key is `ctrl+b` by default. `prefix+?` shows every active binding live.
- A vetted prefix-free setup using safe chords is at https://herdr.dev/docs/keyboard/. Recommend it over improvising.
- Every binding, including the prefix itself, is configurable under `[keys]` in the config file.
- If a direct chord does nothing, the OS or outer terminal consumed it before Herdr could see it.

## Controlling Herdr as an agent

When *you* are running inside a Herdr pane (`HERDR_ENV=1`), use the separate `herdr` skill to control Herdr through the CLI. The skill lives at https://raw.githubusercontent.com/herdrdev/herdr/master/skills/herdr/SKILL.md. In this checkout it can be vended with:

```bash
dot skills add herdrdev/herdr herdr
```

Ask the human before installing or changing their config.

## Configuration

- Config file: `~/.config/herdr/config.toml`. Herdr works without one.
- Print the full default config: `herdr --default-config`
- Apply edits to a running server: `herdr server reload-config`
- Main areas: `[keys]` keybindings, `[theme]` themes, `[ui]` sidebar and UI behavior, `[terminal]` shell defaults, `[update]` channel.
- Full reference: https://herdr.dev/docs/configuration/

## Diagnosis recipes

- **Agent not detected or wrong state:** `herdr agent list` to see what Herdr sees, `herdr agent explain <target> --json` to see why the detector classified a pane the way it did. Install the agent's integration (`herdr integration install <name>`, status via `herdr integration status`) for authoritative state. Details: https://herdr.dev/docs/agents/ and https://herdr.dev/docs/integrations/
- **A keybinding does nothing:** the outer terminal or desktop environment owns that chord. Point the human to https://herdr.dev/docs/keyboard/ to pick a safe one or free the chord in their terminal settings.
- **Startup or socket issues:** logs are at `~/.config/herdr/herdr.log`, `~/.config/herdr/herdr-client.log`, and `~/.config/herdr/herdr-server.log`. `herdr status`, `herdr status server`, and `herdr status client` summarize the runtime.
- **Remote questions:** SSH to the machine and run `herdr` there, or attach as a thin local client with `herdr --remote <host>`. Trade-offs: https://herdr.dev/docs/how-to-work/
- **What survives a detach, restart, or update:** https://herdr.dev/docs/session-state/

## Rules

- Do not invent keybindings, config keys, or CLI flags. Verify against https://herdr.dev/docs/ first.
- Teach mouse before keyboard for humans new to multiplexers.
- Herdr is not tmux: do not give tmux commands, tmux config syntax, or `.tmux.conf` advice.
- For automation, scripting, or controlling Herdr from code, point to the CLI reference (https://herdr.dev/docs/cli-reference/) and socket API (https://herdr.dev/docs/socket-api/).
