import { createInterface } from "node:readline/promises";

export interface Terminal {
  readonly interactive: boolean;
  prompt(message: string): Promise<string>;
  write(message: string): void;
}

export const systemTerminal: Terminal = {
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async prompt(message) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question(message);
    } finally {
      readline.close();
    }
  },
  write(message) {
    process.stdout.write(message);
  },
};
