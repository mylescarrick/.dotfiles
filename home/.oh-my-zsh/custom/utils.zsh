uuid() {
  if command -v uuidgen &>/dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return 0
  fi
  if command -v python3 &>/dev/null; then
    python3 -c "import uuid; print(uuid.uuid4())"
    return 0
  fi
  if command -v node &>/dev/null; then
    node -e "console.log(require('crypto').randomUUID())"
    return 0
  fi
  echo "Error: No UUID generator available (tried uuidgen, python3, node)" >&2
  return 1
}

ulid() {
  if command -v python3 &>/dev/null; then
    python3 -c "
import time, random
alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
t = int(time.time() * 1000)
ts = ''.join(alphabet[(t >> (45 - 5*i)) & 31] for i in range(10))
rnd = ''.join(random.choice(alphabet) for _ in range(16))
print(ts + rnd)
"
    return 0
  fi
  echo "Error: python3 required for ULID generation" >&2
  return 1
}

notify() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: notify <message> [title]"
    return 1
  fi
  local message="$1"
  local title="${2:-Notification}"

  if command -v osascript &>/dev/null; then
    osascript -e "display notification \"$message\" with title \"$title\""
    return 0
  fi
  if command -v notify-send &>/dev/null; then
    notify-send "$title" "$message"
    return 0
  fi
  echo "[$title] $message"
}

timer() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: timer <duration>"
    echo "Duration examples: 5s, 10m, 1h, 90"
    echo "Default unit is seconds if no suffix provided"
    return 1
  fi

  local duration="$1" seconds

  if [[ "$duration" =~ ^[0-9]+s$ ]]; then
    seconds="${duration%s}"
  elif [[ "$duration" =~ ^[0-9]+m$ ]]; then
    seconds=$(( ${duration%m} * 60 ))
  elif [[ "$duration" =~ ^[0-9]+h$ ]]; then
    seconds=$(( ${duration%h} * 3600 ))
  elif [[ "$duration" =~ ^[0-9]+$ ]]; then
    seconds="$duration"
  else
    echo "Error: Invalid duration format"
    echo "Use formats like: 5s, 10m, 1h, or just a number for seconds"
    return 1
  fi

  echo "Timer started for $seconds seconds..."
  sleep "$seconds"
  echo "⏰ Time's up!"

  if typeset -f notify &>/dev/null; then
    notify "Timer finished!" "⏰ Timer"
  elif command -v osascript &>/dev/null; then
    osascript -e 'display notification "Timer finished!" with title "⏰ Timer"'
  fi

  if command -v afplay &>/dev/null; then
    afplay /System/Library/Sounds/Glass.aiff &>/dev/null &
  elif command -v tput &>/dev/null; then
    tput bel
  fi
}

nato() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: nato <text>"
    echo "Convert text to NATO phonetic alphabet"
    echo "Example: nato hello"
    return 1
  fi

  local -A NATO=(
    a Alpha b Bravo c Charlie d Delta e Echo f Foxtrot g Golf h Hotel
    i India j Juliet k Kilo l Lima m Mike n November o Oscar p Papa
    q Quebec r Romeo s Sierra t Tango u Uniform v Victor w Whiskey
    x X-ray y Yankee z Zulu
    0 Zero 1 One 2 Two 3 Three 4 Four 5 Five 6 Six 7 Seven 8 Eight 9 Nine
  )

  local input result=() i char
  input=$(echo "$*" | tr '[:upper:]' '[:lower:]')

  for (( i = 1; i <= ${#input}; i++ )); do
    char="${input:$((i - 1)):1}"
    if [[ "$char" == " " ]]; then
      result+=("/")
    elif [[ -n "${NATO[$char]}" ]]; then
      result+=("${NATO[$char]}")
    else
      result+=("$char")
    fi
  done

  echo "${result[@]}"
}

rn() {
  date "+%l:%M%p on %A, %B %d, %Y" | sed 's/^ *//'
  echo
  cal
}

tempd() {
  local tmpdir
  tmpdir=$(mktemp -d)
  cd "$tmpdir"
  echo "$tmpdir"
}

trash() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: trash <file>..."
    echo "Move files to the trash instead of permanently deleting them"
    return 1
  fi

  local trash_dir
  if [[ "$(uname)" == "Darwin" ]]; then
    trash_dir=~/.Trash
  elif [[ -n "$XDG_DATA_HOME" ]]; then
    trash_dir="$XDG_DATA_HOME/Trash/files"
  else
    trash_dir=~/.local/share/Trash/files
  fi

  [[ -d "$trash_dir" ]] || mkdir -p "$trash_dir"

  local file base dest
  for file in "$@"; do
    if [[ ! -e "$file" ]]; then
      echo "Error: '$file' does not exist"
      continue
    fi
    base=$(basename "$file")
    dest="$trash_dir/$base"
    [[ -e "$dest" ]] && dest="$trash_dir/$base.$(date +%s)"
    mv -v "$file" "$dest"
  done
}

httpstatus() {
  local -a codes_1xx codes_2xx codes_3xx codes_4xx codes_5xx
  codes_1xx=("100:Continue" "101:Switching Protocols" "102:Processing" "103:Early Hints")
  codes_2xx=("200:OK" "201:Created" "202:Accepted" "203:Non-Authoritative Information"
             "204:No Content" "205:Reset Content" "206:Partial Content" "207:Multi-Status"
             "208:Already Reported" "226:IM Used")
  codes_3xx=("300:Multiple Choices" "301:Moved Permanently" "302:Found" "303:See Other"
             "304:Not Modified" "305:Use Proxy" "307:Temporary Redirect" "308:Permanent Redirect")
  codes_4xx=("400:Bad Request" "401:Unauthorized" "402:Payment Required" "403:Forbidden"
             "404:Not Found" "405:Method Not Allowed" "406:Not Acceptable"
             "407:Proxy Authentication Required" "408:Request Timeout" "409:Conflict" "410:Gone"
             "411:Length Required" "412:Precondition Failed" "413:Payload Too Large"
             "414:URI Too Long" "415:Unsupported Media Type" "416:Range Not Satisfactory"
             "417:Expectation Failed" "418:I'm a teapot" "421:Misdirected Request"
             "422:Unprocessable Entity" "423:Locked" "424:Failed Dependency" "425:Too Early"
             "426:Upgrade Required" "428:Precondition Required" "429:Too Many Requests"
             "431:Request Header Fields Too Large" "451:Unavailable For Legal Reasons")
  codes_5xx=("500:Internal Server Error" "501:Not Implemented" "502:Bad Gateway"
             "503:Service Unavailable" "504:Gateway Timeout" "505:HTTP Version Not Supported"
             "506:Variant Also Negotiates" "507:Insufficient Storage" "508:Loop Detected"
             "510:Not Extended" "511:Network Authentication Required")

  if [[ $# -lt 1 ]]; then
    echo "Usage: httpstatus <code|pattern>"
    echo "Examples:"
    echo "  httpstatus 404       # Show specific code"
    echo "  httpstatus 2*        # Show all 2xx codes"
    echo "  httpstatus 40*       # Show all 40x codes"
    echo "  httpstatus 200-299   # Show range of codes"
    return 1
  fi

  local query="$1" found=0 category entry code desc

  if [[ "$query" == *'*' ]]; then
    local prefix="${query%\*}"
    for category in codes_1xx codes_2xx codes_3xx codes_4xx codes_5xx; do
      for entry in ${(P)category}; do
        code="${entry%%:*}"
        desc="${entry#*:}"
        if [[ "$code" == "$prefix"* ]]; then
          echo "$code: $desc"
          found=1
        fi
      done
    done
    [[ $found -eq 0 ]] && { echo "No status codes found matching: $query"; return 1; }
    return 0
  fi

  if [[ "$query" =~ ^[0-9]+-[0-9]+$ ]]; then
    local start="${query%-*}" end="${query#*-}"
    for category in codes_1xx codes_2xx codes_3xx codes_4xx codes_5xx; do
      for entry in ${(P)category}; do
        code="${entry%%:*}"
        desc="${entry#*:}"
        if (( code >= start && code <= end )); then
          echo "$code: $desc"
          found=1
        fi
      done
    done
    [[ $found -eq 0 ]] && { echo "No status codes found in range: $query"; return 1; }
    return 0
  fi

  for category in codes_1xx codes_2xx codes_3xx codes_4xx codes_5xx; do
    for entry in ${(P)category}; do
      code="${entry%%:*}"
      desc="${entry#*:}"
      if [[ "$code" == "$query" ]]; then
        echo "$code: $desc"
        found=1
        break 2
      fi
    done
  done

  [[ $found -eq 0 ]] && { echo "Unknown HTTP status code: $query"; return 1; }
}

bgr() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: bgr <command> [args...]"
    return 1
  fi
  "$@" &>/dev/null &
  disown
}

fvim() {
  if [[ $# -eq 0 ]]; then
    fd -H -t f | fzf --header "Open File in Editor" --preview "cat {}" | xargs ${=EDITOR:-vi}
  else
    fd -H -t f | fzf --header "Open File in Editor" --preview "cat {}" -q "$*" | xargs ${=EDITOR:-vi}
  fi
}

scratch() {
  local tmpfile
  tmpfile=$(mktemp)
  ${=EDITOR:-nano} "$tmpfile"
}
