import { guardCanonicalCheckout } from "./checkout";
import { applyPiSettings, planPiSettings } from "./pi";
import type { ProcessRunner } from "./process";
import { applyStow } from "./stow";
import type { Terminal } from "./terminal";

export async function apply(options: {
  readonly acceptTracked: boolean;
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
  readonly terminal: Terminal;
}): Promise<string> {
  await guardCanonicalCheckout(options);
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");
  await planPiSettings({ checkoutRoot: options.checkoutRoot, home });
  const stowSummary = await applyStow({ ...options, home });
  const piSettings = await planPiSettings({
    checkoutRoot: options.checkoutRoot,
    home,
  });
  const changed = await applyPiSettings(piSettings);
  return `${stowSummary}${changed ? "Pi settings synced" : "Pi settings already current"}\n`;
}
