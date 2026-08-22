import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n\n");
}

interface SessionBranchEntry {
  readonly message?: { readonly role?: string };
  readonly type?: string;
}

function latestAssistantMessage(branch: readonly SessionBranchEntry[]): AssistantMessage | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      return entry.message as AssistantMessage;
    }
  }
  return undefined;
}

/** Writes with the exclusive flag so an existing file is reported rather than clobbered. */
async function writeNewMarkdownFile(path: string, markdown: string): Promise<"written" | "exists"> {
  try {
    await writeFile(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return "written";
  } catch (error) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: typeof x === "object" is true for null in JS, so the null check is genuinely required, not redundant
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return "exists";
    }
    throw error;
  }
}

export default function saveMarkdownExtension(pi: ExtensionAPI) {
  pi.registerCommand("save-md", {
    description: "Save the latest assistant response as Markdown (usage: /save-md name)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const assistantMessage = latestAssistantMessage(ctx.sessionManager.getBranch());
      if (!assistantMessage) {
        ctx.ui.notify("No assistant response to save", "warning");
        return;
      }

      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /save-md name", "warning");
        return;
      }

      const markdown = textContent(assistantMessage.content);
      if (!markdown.trim()) {
        ctx.ui.notify("The latest assistant response has no Markdown text", "warning");
        return;
      }

      const fileName = name.endsWith(".md") ? name : `${name}.md`;
      const path = resolve(ctx.cwd, fileName);

      if ((await writeNewMarkdownFile(path, markdown)) === "exists") {
        ctx.ui.notify(`File already exists: ${path}`, "error");
        return;
      }

      const message = `Saved Markdown to ${path}`;
      pi.sendMessage(
        {
          content: message,
          customType: "save-md",
          display: true,
        },
        { deliverAs: "nextTurn" }
      );
      ctx.ui.notify(message, "info");
    },
  });
}
