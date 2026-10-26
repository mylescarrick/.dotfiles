import { describe, expect, test } from "bun:test";
import { decide } from "../src/skill-drift";

describe("three-way skill rule", () => {
  test.each([
    ["installs when nothing was deployed", { desired: "d" }, { action: "install" }],
    [
      "reports a deliberate local delete",
      { desired: "d", recorded: "d" },
      { action: "drift", kind: "deleted-locally" },
    ],
    ["accepts a match", { current: "d", desired: "d", recorded: "old" }, { action: "in-sync" }],
    ["updates an untouched copy", { current: "r", desired: "d", recorded: "r" }, { action: "update" }],
    [
      "keeps a local edit",
      { current: "c", desired: "d", recorded: "d" },
      { action: "drift", kind: "modified-locally" },
    ],
    [
      "flags both sides changing",
      { current: "c", desired: "d", recorded: "r" },
      { action: "drift", kind: "conflict" },
    ],
    ["flags unknown existing content", { current: "c", desired: "d" }, { action: "drift", kind: "conflict" }],
    ["removes what the repo dropped", { current: "r", recorded: "r" }, { action: "remove" }],
    [
      "keeps an edited copy the repo dropped",
      { current: "c", recorded: "r" },
      { action: "drift", kind: "conflict" },
    ],
    ["forgets a record with nothing left", { recorded: "r" }, { action: "forget" }],
    ["reports something new", { current: "c" }, { action: "drift", kind: "added-locally" }],
  ] as const)("%s", (_name, input, expected) => {
    expect(decide(input)).toEqual(expected);
  });
});
