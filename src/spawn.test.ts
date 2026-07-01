import { describe, test, expect } from "bun:test";
import { spawn, bareSshHost } from "./spawn";
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

describe("bareSshHost — bare host for the WIRE_SSH_HOST attach convention", () => {
  // crew's machine-table ssh_host carries the ssh user (`tim@host`) because crew
  // runs `ssh <ssh_host>` directly, but WireAttach.app prepends `tim@` itself — so
  // the attach button needs a BARE host or it builds `ssh tim@tim@…`.
  test("strips a leading user@", () => {
    expect(bareSshHost("tim@patisserie.tail3ef8a5.ts.net")).toBe("patisserie.tail3ef8a5.ts.net");
  });
  test("is idempotent on an already-bare host", () => {
    expect(bareSshHost("tims-mac-mini.local")).toBe("tims-mac-mini.local");
  });
  test("strips only the leading user@ (rest of the host preserved verbatim)", () => {
    expect(bareSshHost("root@host@weird")).toBe("host@weird");
  });
});
