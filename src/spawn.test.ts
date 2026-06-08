import { describe, test, expect } from "bun:test";
import { spawn } from "./spawn";
import type { SpawnDeps } from "./spawn";
import type { SpawnOptions } from "./types";

// The worktree guard fires at the very top of spawn(), before any deps are
// touched, so an empty deps object is fine for these cases.
const fakeDeps = {} as unknown as SpawnDeps;
const base: SpawnOptions = { agent_id: "x", roles: ["eng"], task: "t" };

async function messageOf(opts: SpawnOptions): Promise<string> {
  try {
    await spawn(opts, fakeDeps, new Map());
    return "<no throw>";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("spawn — git-worktree subpath guard", () => {
  for (const dir of [
    "/Users/tim/Projects/Fabrica/fabrica-v3/worktrees/eng-3012-foo",
    "fabrica-v3/worktrees/branch",
    "/repo/worktrees/a/b",
  ]) {
    test(`rejects a worktree subpath: ${dir}`, async () => {
      await expect(spawn({ ...base, project_dir: dir }, fakeDeps, new Map())).rejects.toThrow(/worktrees/);
    });
  }

  test("a normal project root passes the guard (fails later, not on worktrees)", async () => {
    // Passes the guard, then fails at Wire registration against empty deps —
    // the point is the failure is NOT the worktree guard.
    const msg = await messageOf({ ...base, project_dir: "/Users/tim/Projects/Agiterra/wallet-extension" });
    expect(msg).not.toContain("worktrees");
  });

  test("does NOT false-positive on 'myworktrees' (path-segment boundary respected)", async () => {
    const msg = await messageOf({ ...base, project_dir: "/Users/tim/myworktrees/x" });
    expect(msg).not.toContain("worktrees");
  });

  test("no project_dir → guard is a no-op", async () => {
    const msg = await messageOf({ ...base });
    expect(msg).not.toContain("worktrees");
  });
});
