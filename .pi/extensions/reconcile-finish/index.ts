import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Lets the reconcile agent end its own session, so the user is not asked to quit Pi before
 * `dot` can push and open the PR. Shutdown waits for the agent to go idle, so the final
 * summary still prints. Loaded only by `dot reconcile` (via -e), never globally.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    description:
      "Call once every drift item is added, skipped or ignored, the work is committed, and you have given the user your final summary. Ends this session so dot can push and open the PR.",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctx.shutdown();
      return {
        content: [{ text: "Session ending; dot will push and open the PR.", type: "text" }],
        details: {},
      };
    },
    label: "Finish reconcile",
    name: "reconcile_finish",
    parameters: Type.Object({}),
  });
}
