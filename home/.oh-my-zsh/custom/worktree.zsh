__wt.dir() {
  if [[ -n "$WT_DIR" ]]; then
    echo "$WT_DIR"
    return
  fi

  local common_dir
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1

  if [[ "$(basename "$common_dir")" == ".bare" ]]; then
    dirname "$common_dir"
    return
  fi

  local top_level
  top_level=$(git rev-parse --show-toplevel 2>/dev/null) || return 1
  dirname "$top_level"
}

wt() {
  local branch="$1" base="$2"
  if [[ -z "$branch" ]]; then
    echo "Usage: wt branch [base]"
    return 1
  fi
  [[ -z "$base" ]] && base="main"

  local worktree_dir
  worktree_dir=$(__wt.dir) || return 1

  git worktree add -b "$branch" "$worktree_dir/$branch" "$base"
}

wtcd() {
  local directory="$1"
  if [[ -z "$directory" ]]; then
    echo "Usage: wtcd directory"
    return 1
  fi

  local worktree_dir
  worktree_dir=$(__wt.dir) || return 1

  cd "$worktree_dir/$directory"
}

wtd() {
  local branch="$1" directory="$2"
  if [[ -z "$branch" ]]; then
    echo "Usage: wtd branch [directory]"
    return 1
  fi
  [[ -z "$directory" ]] && directory="${branch//\//-}"

  local worktree_dir
  worktree_dir=$(__wt.dir) || return 1

  git fetch origin "$branch" && git worktree add --detach "$worktree_dir/$directory" "origin/$branch"
}

wtl() {
  git worktree list
}

wtp() {
  git worktree prune -v
}

wtr() {
  local keep=false
  if [[ "$1" == "-k" || "$1" == "--keep" ]]; then
    keep=true
    shift
  fi

  if [[ $# -ne 1 ]]; then
    echo "Usage: wtr [-k|--keep] directory"
    return 1
  fi

  local worktree_dir
  worktree_dir=$(__wt.dir) || return 1

  local directory="$1" worktree
  if [[ "$directory" == /* ]]; then
    worktree="$directory"
  else
    worktree="$worktree_dir/$directory"
  fi

  local branch
  branch=$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null)

  git worktree remove "$worktree" || return 1

  if [[ "$keep" == false && -n "$branch" ]]; then
    git branch -d "$branch"
  fi
}
