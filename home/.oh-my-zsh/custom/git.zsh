# Custom git helpers not covered by the oh-my-zsh git plugin.
# git_main_branch / git_current_branch / gbda / gbds / grename / gdv all
# already exist there - build on them instead of duplicating.

gbage() {
  git for-each-ref --sort=committerdate refs/heads/ \
    --format="%(HEAD) %(color:yellow)%(refname:short)%(color:reset) - %(color:red)%(objectname:short)%(color:reset) - %(contents:subject) - %(authorname) (%(color:green)%(committerdate:relative)%(color:reset))"
}

gtest() {
  git stash push -q --keep-index --include-untracked || return
  "$@"
  local cmdstatus=$?
  git reset -q
  git restore .
  git stash pop -q --index || return $?
  return $cmdstatus
}

# oh-my-zsh's git plugin already aliases glp to _git_log_prettily; unalias so
# this (differently-behaved, format-name-driven) version can be a function.
unalias glp 2>/dev/null
glp() {
  [[ -n "$1" ]] && git log --pretty="$1"
}

__git_rebase_stack.detect() {
  local branch="$1"
  local prs
  prs=$(gh pr list --author @me --state open --json headRefName,baseRefName 2>/dev/null) || return 1

  local -a heads bases
  heads=("${(@f)$(echo "$prs" | jq -r '.[].headRefName')}")
  bases=("${(@f)$(echo "$prs" | jq -r '.[].baseRefName')}")

  local stack_bottom current found_base i j
  for ((i = 1; i <= ${#heads[@]}; i++)); do
    if [[ "${heads[$i]}" == "$branch" ]]; then
      current="$branch"
      while true; do
        found_base=""
        for ((j = 1; j <= ${#heads[@]}; j++)); do
          if [[ "${heads[$j]}" == "$current" ]]; then
            found_base="${bases[$j]}"
            break
          fi
        done
        if (( ${heads[(Ie)$found_base]} )); then
          current="$found_base"
        else
          stack_bottom="$current"
          break
        fi
      done
      break
    fi
  done

  [[ -z "$stack_bottom" ]] && return 1

  local -a stack
  stack=("$stack_bottom")
  current="$stack_bottom"
  while true; do
    local found_child=""
    for ((i = 1; i <= ${#bases[@]}; i++)); do
      if [[ "${bases[$i]}" == "$current" ]]; then
        found_child="${heads[$i]}"
        break
      fi
    done
    if [[ -n "$found_child" ]]; then
      stack+=("$found_child")
      current="$found_child"
    else
      break
    fi
  done

  echo "${stack[@]}"
}

git_rebase_stack() {
  local base="" dry_run=false
  local -a branches

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -b|--base) base="$2"; shift 2 ;;
      -d|--dry-run) dry_run=true; shift ;;
      *) branches+=("$1"); shift ;;
    esac
  done

  local original_branch
  original_branch=$(git branch --show-current)

  if [[ ${#branches[@]} -eq 0 ]]; then
    branches=($(__git_rebase_stack.detect "$original_branch"))
    if [[ ${#branches[@]} -eq 0 ]]; then
      echo "No stack detected from current branch"
      return 1
    fi
    if [[ -z "$base" ]]; then
      base=$(gh pr view "${branches[1]}" --json baseRefName -q '.baseRefName' 2>/dev/null)
    fi
  fi

  [[ -z "$base" ]] && base=$(git_main_branch)

  echo "Base: $base"
  echo "Stack: ${branches[*]}"

  $dry_run && return 0

  git fetch origin "$base" || return 1

  local i branch rebase_onto
  for ((i = 1; i <= ${#branches[@]}; i++)); do
    branch="${branches[$i]}"
    if [[ $i -eq 1 ]]; then
      rebase_onto="origin/$base"
    else
      rebase_onto="${branches[$((i - 1))]}"
    fi

    echo "Rebasing $branch onto $rebase_onto..."
    git checkout "$branch" || return 1

    if ! git rebase "$rebase_onto"; then
      echo "Rebase failed for $branch. Aborting."
      git rebase --abort
      git checkout "$original_branch"
      return 1
    fi

    echo "Pushing $branch..."
    git push --force-with-lease origin "$branch" || return 1
  done

  git checkout "$original_branch"
  echo "Done. All branches rebased and pushed."
}

gstk() {
  git_rebase_stack "$@"
}
