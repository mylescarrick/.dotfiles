import { readFile } from "node:fs/promises";
import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkEnvKeys, classifyBashCommand, isProtectedPath, resolveSafeEnvPath } from "./policy.ts";

function allowKey(kind: string, value: string, cwd: string): string {
  return `${kind}:${cwd}:${value}`;
}

async function confirmOrBlock(
  title: string,
  message: string,
  key: string,
  sessionAllows: Set<string>,
  ctx: ExtensionContext
): Promise<{ block: true; reason: string } | undefined> {
  if (sessionAllows.has(key)) return;
  if (!ctx.hasUI) return { block: true, reason: `${message} Blocked in non-interactive mode.` };

  const allowed = await ctx.ui.confirm(title, `${message}\n\nAllow this action for the current session?`);
  if (!allowed) return { block: true, reason: message };
  sessionAllows.add(key);
}

export default function safetyGuard(pi: ExtensionAPI) {
  const sessionAllows = new Set<string>();

  pi.registerTool({
    description:
      "Checks whether explicitly named keys exist in a dotenv file without exposing any values or file contents.",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const path = resolveSafeEnvPath(params.path, ctx.cwd);
      if (!path) throw new Error("env_check_keys only accepts .env or .env.<name> files");
      if (signal?.aborted) throw new Error("env_check_keys cancelled");

      const text = await readFile(path, { encoding: "utf8", signal });
      const keys = [...new Set(params.keys)];
      const statuses = checkEnvKeys(text, keys);
      return {
        content: [
          {
            text: statuses.map(({ key, present }) => `${key}: ${present ? "present" : "missing"}`).join("\n"),
            type: "text" as const,
          },
        ],
        details: { path, statuses },
      };
    },
    label: "Check dotenv keys",
    name: "env_check_keys",
    parameters: Type.Object({
      keys: Type.Array(Type.String({ maxLength: 128, minLength: 1 }), { maxItems: 50, minItems: 1 }),
      path: Type.String({ description: "Path to a .env or .env.<name> file" }),
    }),
    promptGuidelines: [
      "Use env_check_keys, rather than read or bash, when the task only needs to verify whether a dotenv file contains specific keys.",
    ],
    promptSnippet: "Check explicitly named dotenv keys without exposing secret values",
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const risk = classifyBashCommand(event.input.command);
      if (!risk) return;
      return await confirmOrBlock(
        "Safety guard: risky Bash command",
        `${risk.label}: ${event.input.command}`,
        allowKey("bash", event.input.command, ctx.cwd),
        sessionAllows,
        ctx
      );
    }

    if (
      !(
        isToolCallEventType("read", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      )
    ) {
      return;
    }
    if (!isProtectedPath(event.input.path, ctx.cwd)) return;

    return await confirmOrBlock(
      "Safety guard: protected path",
      `${event.toolName} ${event.input.path}`,
      allowKey(event.toolName, event.input.path, ctx.cwd),
      sessionAllows,
      ctx
    );
  });

  pi.registerCommand("safety-guard", {
    description: "Show or clear session-only approvals",
    handler: async (args, ctx) => {
      if (args.trim() === "clear") {
        sessionAllows.clear();
        ctx.ui.notify("Safety guard session approvals cleared", "info");
        return;
      }
      ctx.ui.notify(
        `Safety guard active, ${sessionAllows.size} session approval(s). Use /safety-guard clear to reset.`,
        "info"
      );
    },
  });
}
