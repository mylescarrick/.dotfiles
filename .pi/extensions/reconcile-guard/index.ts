import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { checkBash, checkWritePath } from "./policy.ts";

/**
 * Narrows what the agent `dot reconcile` starts can do. Inert unless dot set DOT_RECONCILE, so
 * an ordinary Pi session in this repo is untouched.
 */
export default function (pi: ExtensionAPI) {
  if (!process.env.DOT_RECONCILE) return;

  pi.on("tool_call", (event, ctx) => {
    const worktree = ctx.cwd;
    if (isToolCallEventType("bash", event)) {
      const reason = checkBash(event.input.command, worktree);
      return reason ? { block: true, reason } : undefined;
    }
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const reason = checkWritePath(event.input.path, worktree);
      return reason ? { block: true, reason } : undefined;
    }
    return undefined;
  });
}
