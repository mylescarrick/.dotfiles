# Herdr Commands

Check availability:

```text
/herdr-status
herdr_available
```

Start one read-only worker:

```text
/herdr-start researcher --name researcher-auth -- Read the auth flow and summarize files, invariants, and open questions. Do not edit.
```

Start a verifier that may run checks but should not edit:

```text
/herdr-start verifier --name verifier-tests -- Reproduce the failing test and report the smallest command plus failure details. Do not edit.
```

Start a write-capable executor only after explicit approval, preferably in a separate worktree:

```text
/herdr-start executor --name executor-task-1 --cwd /path/to/worktree --write -- Implement task 1. Do not commit unless explicitly instructed.
```

Read and wait:

```text
/herdr-read researcher-auth --lines 120
/herdr-wait researcher-auth --state idle --timeout-ms 120000
```

Tools available to Pi:

```text
herdr_available
herdr_start_agent
herdr_read_agent
herdr_wait_agent
herdr_send_agent
```
