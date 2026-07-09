# Dotfiles

A comprehensive, automated dotfiles management system for macOS development environments. Features a powerful CLI tool for setup, maintenance, and AI-powered development insights.

## Overview

This repository contains my personal development environment configuration, managed through a custom CLI tool called `dot`. It uses GNU Stow for symlink management, Homebrew for package installation, and includes configurations for Zsh (oh-my-zsh), Git, and AI coding agent tooling (`pi`, Claude Code).

### Key Features

- 🚀 **One-command setup** - Complete development environment in minutes
- 🤖 **AI Integration** - `pi` and Claude Code, with a shared agent-skills library
- 📦 **Resilient Package Management** - Continues installation even if packages fail
- 🔍 **Health Monitoring** - Comprehensive environment diagnostics
- 🪪 **Personal/Work Identity Split** - Automatic Git identity switching by directory

## Quick Start

```bash
# Clone the repository
git clone https://github.com/mylescarrick/.dotfiles.git ~/.dotfiles
cd ~/.dotfiles

# Full setup (installs everything)
./dot init

# Or customize the installation
./dot init --skip-ssh --skip-font
```

After installation, the `dot` command will be available globally for ongoing management. Running `dot` without arguments shows help.

## Repository Structure

```
~/.dotfiles/
├── dot                 # Main CLI tool
├── home/               # Configuration files (stowed to ~)
│   ├── .config/
│   │   ├── git/        # Git configuration (personal + work)
│   │   ├── ghostty/    # Terminal
│   │   ├── ripgrep/    # rg config
│   │   └── starship.toml
│   ├── .agents/skills/ # Canonical agent-skills library (shared across agents)
│   ├── .pi/            # pi agent workspace (extensions, settings, skill symlinks)
│   ├── .oh-my-zsh/custom/ # Custom zsh functions/aliases (git, worktrees, utils)
│   ├── .zshrc / .zprofile
│   └── .local/bin/     # Personal scripts
├── packages/
│   └── bundle          # Base Brewfile
├── AGENTS.md           # Instructions for AI assistants
└── README.md           # This file
```

## Git Identity

Git identity switches automatically based on directory, via a conditional include:

- **Default** (everywhere): personal identity, set in `home/.config/git/config`
- **Work override**: anything under `~/Code/work/` picks up `home/.config/git/work_config` instead

If you have a pre-existing `~/.gitconfig`, be aware it takes priority over the XDG `~/.config/git/config` for any values it sets — remove or empty it so the conditional include actually takes effect.

## Agent Skills

`home/.agents/skills/` is the canonical store for agent skills (mostly vendored from [mattpocock/skills](https://github.com/mattpocock/skills), plus a few local ones). Skills installed here globally (via the [`skills`](https://skills.sh) CLI, `skills add <source> -g`) are shared across every agent whose global skills directory is `~/.agents/skills/` directly (cline, warp, zed, etc.).

For agents with their own global skills directory — `pi` (`~/.pi/agent/skills/`) and Claude Code (`~/.claude/skills/`) — this repo mirrors each canonical skill in as a relative symlink back to `.agents/skills/`, matching exactly how the `skills` CLI's own symlink install mode works. Because this repo is stowed straight into `$HOME`, running `skills add`/`skills update` globally writes directly into this git repo — no separate export step needed.

## The `dot` CLI Tool

The `dot` command is a comprehensive management tool for your dotfiles. It handles everything from initial setup to ongoing maintenance and provides AI-powered insights.

### Installation Commands

#### `dot init` - Initial Setup
Complete environment setup with all tools and configurations.

```bash
# Full installation
dot init

# Skip SSH key generation
dot init --skip-ssh

# Skip font installation  
dot init --skip-font

# Skip both SSH and font setup
dot init --skip-ssh --skip-font
```

**What it does:**
1. Installs Homebrew (if not present)
2. Installs packages from the Brewfile
3. Creates symlinks with GNU Stow
4. Installs Bun runtime
5. Installs pi via the Vite+ tool registry
6. Generates SSH key for GitHub (optional)
7. Installs a Nerd Font via Homebrew cask (optional)
8. Installs oh-my-zsh if not already present

### Maintenance Commands

#### `dot update` - Update Everything
```bash
dot update
```
- Pulls latest dotfiles changes
- Updates Homebrew packages
- Re-stows configuration files
- Runs `pi update` to update pi and its configured packages

#### `dot doctor` - Health Check
```bash
dot doctor
```
Comprehensive diagnostics including:
- ✅ Homebrew installation
- ✅ Essential tools (git, node, npm, etc.)
- ✅ pi installation and core development tools
- ✅ oh-my-zsh installation and default shell
- ✅ PATH configuration
- ⚠️ Broken symlinks detection
- ⚠️ Missing dependencies

#### `dot check-packages` - Package Status
```bash
dot check-packages
```
Shows which packages are installed vs. missing from your Brewfile.

#### `dot retry-failed` - Retry Failed Installations
```bash
dot retry-failed
```
Attempts to reinstall packages that failed during initial setup.

### Utility Commands

#### `dot edit` - Open in Editor
```bash
dot edit
```
Opens the dotfiles directory in your default editor (defined by `$EDITOR`, defaults to `code -w`).

#### `dot stow` - Update Dotfiles Symlinks
```bash
# Create/update symlinks for configuration files
dot stow
```
Re-creates symlinks from `home/` directory to your home directory (`~`). Use this after editing configuration files.

#### `dot link` / `dot unlink` - Global dot Command Installation
```bash
# Install dot command globally (add to PATH)
dot link

# Remove global installation
dot unlink
```
Makes the `dot` command available from any directory by creating a symlink in `/usr/local/bin` or `~/.local/bin`.

## Configuration

### Package Management

The system provides comprehensive package management through the `dot package` command.

#### Package Commands

```bash
# List packages
dot package list              # List all packages

# Add packages
dot package add git           # Add git formula to base bundle
dot package add docker cask   # Add docker cask to base bundle

# Update packages
dot package update            # Update all installed packages
dot package update git        # Update specific package

# Remove packages
dot package remove git        # Remove git from the bundle
```

#### Package Features

- **Auto-detection**: Package type (brew vs cask) automatically detected
- **Sorted maintenance**: Packages kept alphabetically sorted within each type
- **Installation integration**: Adding packages installs them immediately
- **Cleanup included**: Update command includes Homebrew refresh and optional cleanup

### Key Configurations

- **Zsh**: oh-my-zsh with custom functions/aliases in `home/.oh-my-zsh/custom/` (git helpers, worktree management, general utilities)
- **Git**: Conditional work configuration, custom aliases, GPG signing

### Architecture Highlights

- **GNU Stow**: Manages symlinks from `home/` to `~`
- **Modular Design**: Separate configs for different tools
- **Conditional Loading**: Work-specific Git config for `~/Code/work/`
- **Plugin Managers**: oh-my-zsh plugin list in `home/.zshrc`
- **Error Resilience**: Package installation continues despite individual failures

## Environment Setup

### Prerequisites

- macOS (Intel or Apple Silicon)
- Internet connection
- Terminal access

### First-Time Setup

1. **Clone repository:**
   ```bash
   git clone https://github.com/mylescarrick/.dotfiles.git ~/.dotfiles
   cd ~/.dotfiles
   ```

2. **Run installation:**
   ```bash
   ./dot init
   ```

3. **Restart shell or source Zsh config:**
   ```bash
   source ~/.zshrc
   
   # Or restart terminal
   ```

4. **Verify installation:**
   ```bash
   dot doctor
   ```

### Customization

#### Adding Packages

**Method 1: Using package commands (recommended):**
```bash
dot package add new-tool             # Adds to the bundle
dot package add new-app cask         # Adds cask to the bundle
```

**Method 2: Manual editing:**
Edit `packages/bundle`:
```ruby
brew "new-tool"
cask "new-app"
```

Then run:
```bash
dot init  # or brew bundle --file=./packages/bundle
```

#### Modifying Configurations
1. Edit files in `home/` directory (not your actual home directory)
2. Re-stow changes: `dot stow` (or `dot init` for full setup)
3. Test configuration changes

#### Work-Specific Setup
The system automatically applies work-specific Git configuration for repositories under `~/Code/work/`.

## Troubleshooting

### Common Issues

**Command not found: `dot`**
```bash
# Source Zsh configuration
source ~/.zshrc

# Or add to PATH manually (belongs in ~/.zprofile for login shells)
export PATH="$HOME/.dotfiles:$PATH"
```

**Package installation failures:**
```bash
# Check what failed
dot check-packages

# Retry failed packages
dot retry-failed
```

**Broken symlinks:**
```bash
# Diagnose issues
dot doctor

# Re-create symlinks
dot stow
```

**Git identity resolving unexpectedly:**
```bash
# Check for a competing ~/.gitconfig that overrides home/.config/git/config
cat ~/.gitconfig
```

**pi installation issues:**
```bash
# Ensure Vite+ is installed, then install pi from the tool registry
curl -fsSL https://vite.plus | bash
vp install -g @mariozechner/pi-coding-agent
```

### Getting Help

- Run `dot help` for command overview
- Run `dot <command> --help` for specific command help
- Check `dot doctor` for environment issues
- Review logs in failed package files: `packages/failed_packages_*.txt`

## Development

### Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes in the `home/` directory structure
4. Test with `dot doctor` and `dot check-packages`
5. Submit a pull request

### Testing Changes

```bash
# Make modifications to dotfiles
# ...

# Test changes
dot doctor

# Re-stow if needed
dot stow
```

## Advanced Usage

### Selective Installation

```bash
# Install only base packages, skip optional components
dot init --skip-ssh --skip-font

# Check what's missing
dot check-packages
```

## License

This repository is for personal use. Feel free to fork and adapt for your own needs.

## Acknowledgments

- [GNU Stow](https://www.gnu.org/software/stow/) for symlink management
- [Homebrew](https://brew.sh/) for package management
- [mattpocock/skills](https://github.com/mattpocock/skills) and [skills.sh](https://skills.sh) for the agent-skills library
- pi and Claude Code for AI assistance
- The dotfiles community for inspiration and best practices
