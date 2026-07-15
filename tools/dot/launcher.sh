#!/bin/sh

set -eu

fail() {
  printf 'dot: %s\n' "$1" >&2
  exit 1
}

usage_error() {
  printf '%s\n' "dot: usage: dot update [--yes]" >&2
  exit 2
}

script=$0
case $script in
  /*) ;;
  *) script=$PWD/$script ;;
esac

while [ -L "$script" ]; do
  script_dir=$(CDPATH= cd "$(dirname "$script")" && pwd -P)
  link=$(readlink "$script")
  case $link in
    /*) script=$link ;;
    *) script=$script_dir/$link ;;
  esac
done

DOTFILES_DIR=$(CDPATH= cd "$(dirname "$script")" && pwd -P)
readonly DOTFILES_DIR

case ${1:-} in
  -*) [ "${2:-}" = "update" ] && usage_error ;;
esac

if [ "${1:-}" = "update" ]; then
  case $# in
    1) ;;
    2) [ "$2" = "--yes" ] || usage_error ;;
    *) usage_error ;;
  esac
fi

if ! bun_path=$(command -v bun); then
  fail "Bun is required; run 'dot init' to bootstrap it."
fi

if [ "${1:-}" = "update" ]; then
  canonical=$HOME/.dotfiles
  if [ ! -d "$canonical" ]; then
    fail "canonical checkout not found at $canonical"
  fi
  canonical=$(CDPATH= cd "$canonical" && pwd -P)
  if [ "$DOTFILES_DIR" != "$canonical" ]; then
    fail "update must run from the canonical checkout at $canonical"
  fi

  if ! git_dir=$(git -C "$DOTFILES_DIR" rev-parse --absolute-git-dir); then
    fail "failed to inspect canonical checkout"
  fi
  for operation in \
    MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG \
    rebase-merge rebase-apply sequencer
  do
    if [ -e "$git_dir/$operation" ]; then
      fail "canonical checkout has an unfinished Git operation"
    fi
  done

  branch=$(git -C "$DOTFILES_DIR" branch --show-current 2>/dev/null || true)
  if [ "$branch" != "main" ]; then
    fail "canonical checkout must be on main (found '${branch:-detached HEAD}')"
  fi
  if ! status=$(git -C "$DOTFILES_DIR" status --porcelain); then
    fail "failed to inspect canonical checkout"
  fi
  if [ -n "$status" ]; then
    fail "canonical checkout has uncommitted changes"
  fi

  if ! git -C "$DOTFILES_DIR" fetch origin; then
    fail "failed to fetch origin"
  fi

  head=$(git -C "$DOTFILES_DIR" rev-parse HEAD)
  if ! remote=$(
    git -C "$DOTFILES_DIR" rev-parse --verify refs/remotes/origin/main 2>/dev/null
  ); then
    fail "origin/main is unavailable after fetch"
  fi
  if [ "$head" != "$remote" ]; then
    if ! git -C "$DOTFILES_DIR" merge-base --is-ancestor "$head" "$remote"; then
      fail "canonical main is ahead of or diverged from origin/main"
    fi
    if ! git -C "$DOTFILES_DIR" merge --ff-only "$remote"; then
      fail "failed to fast-forward canonical main"
    fi

    exec "$DOTFILES_DIR/dot" "$@"
  fi
fi

exec "$bun_path" "$DOTFILES_DIR/tools/dot/src/main.ts" "$@"
