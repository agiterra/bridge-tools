// Worktree isolation for spawned agents.
//
// When two agents share the same project_dir and one of them runs
// `git checkout`, the other's uncommitted work is silently discarded.
// Brioche's 2026-05-26 incident (Eclair lost ~600 lines to Profiterole's
// checkout) drove this fix.
//
// Convention follows fabrica-v3's /workon / worktree-setup.md pattern:
// worktrees live under `<project_dir>/worktrees/<branch>`. We mirror
// engineers' existing setup so the spawned agent feels at home.

import { existsSync } from "fs";
import { join } from "path";

interface SpawnRes {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runGit(cwd: string, args: string[]): Promise<SpawnRes> {
  // Bun.spawn is available at runtime in both bridge-claude-code and
  // bridge-codex hosts. The library doesn't import bun-types at the
  // declaration level — we access it dynamically.
  const bun = (globalThis as { Bun?: { spawn: (opts: unknown) => unknown } }).Bun;
  if (!bun) {
    throw new Error("worktree: Bun runtime required (Bun.spawn missing)");
  }
  const proc = bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  }) as {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Ensure a git worktree exists at `<projectDir>/worktrees/<branch>` and
 * return its absolute path. Idempotent: if the worktree already exists at
 * that path and is checked out to `branch`, returns the path unchanged. If
 * the branch exists locally, the worktree is added without `-b`; otherwise
 * the branch is created with `-b`.
 *
 * Throws if `projectDir` is not a git repo, or if a worktree at the target
 * path exists with a different branch checked out (refusing to clobber).
 */
export async function ensureWorktree(projectDir: string, branch: string): Promise<string> {
  // Validate projectDir is a git repo (or worktree).
  const inside = await runGit(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(
      `worktree: '${projectDir}' is not a git work tree (rev-parse --is-inside-work-tree returned ${inside.exitCode}: ${inside.stderr.trim()})`,
    );
  }

  const worktreePath = join(projectDir, "worktrees", branch);

  // If the worktree path exists, check what branch it has and either reuse
  // or refuse. Don't clobber.
  if (existsSync(worktreePath)) {
    const head = await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.exitCode === 0 && head.stdout.trim() === branch) {
      return worktreePath; // Idempotent reuse.
    }
    throw new Error(
      `worktree: path '${worktreePath}' exists but is checked out to '${head.stdout.trim()}' (wanted '${branch}'). Refusing to clobber.`,
    );
  }

  // Decide whether to use `-b` (create branch) or attach to existing branch.
  const branchCheck = await runGit(projectDir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  const branchExists = branchCheck.exitCode === 0;

  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath];

  const add = await runGit(projectDir, args);
  if (add.exitCode !== 0) {
    throw new Error(
      `worktree: git ${args.join(" ")} failed in ${projectDir}: ${add.stderr.trim() || add.stdout.trim()}`,
    );
  }

  return worktreePath;
}
