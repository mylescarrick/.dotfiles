import { join } from "node:path";

export interface SkillAgentDirectory {
  readonly path: string;
  target(name: string): string;
}

export function skillAgentDirectories(checkoutRoot: string): readonly SkillAgentDirectory[] {
  return [
    {
      path: join(checkoutRoot, "home/.pi/agent/skills"),
      target: (name) => `../../../.agents/skills/${name}`,
    },
    {
      path: join(checkoutRoot, "home/.claude/skills"),
      target: (name) => `../../.agents/skills/${name}`,
    },
  ];
}
