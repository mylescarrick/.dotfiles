import { guardCanonicalCheckout } from "./checkout";
import { syncPiSettings } from "./pi";
import type { ProcessRunner } from "./process";

export async function apply(options: {
  readonly checkoutRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly processes: ProcessRunner;
}): Promise<string> {
  await guardCanonicalCheckout(options);
  const home = options.env.HOME;
  if (!home) throw new Error("HOME is required");
  const changed = await syncPiSettings({ checkoutRoot: options.checkoutRoot, home });
  return changed ? "Pi settings synced\n" : "Pi settings already current\n";
}
