# fnm
FNM_PATH="/opt/homebrew/opt/fnm/bin"
if [ -d "$FNM_PATH" ]; then
  eval "$(fnm env --shell zsh)"
fi

# oh-my-zsh
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(bun brew fnm git git-prompt gh)
source $ZSH/oh-my-zsh.sh

export EDITOR="code -w"

# Starship prompt
command -v starship >/dev/null 2>&1 && eval "$(starship init zsh)"

# zoxide
command -v zoxide >/dev/null 2>&1 && eval "$(zoxide init zsh)"

# rustup
source "$HOME/.cargo/env" 2>/dev/null

# Vite+ (https://viteplus.dev)
function vp() {
  if [[ $# -ge 2 && "$1" == "env" && "$2" == "use" ]]; then
    if [[ "$*" == *"-h"* || "$*" == *"--help"* ]]; then
      command vp "$@"
      return
    fi
    local __vp_out
    __vp_out=$(VP_ENV_USE_EVAL_ENABLE=1 command vp "$@") || return $?
    eval "$__vp_out"
  else
    command vp "$@"
  fi
}
