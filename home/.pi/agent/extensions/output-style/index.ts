import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadStyle } from "./style.ts";

export default function outputStyle(pi: ExtensionAPI) {
  let style: string;

  try {
    style = loadStyle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn(`[output-style] could not load output style: ${message}`);
    return;
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Output style\n\n${style}`,
  }));
}
