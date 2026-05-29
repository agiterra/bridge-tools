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

/**
 * A single source-side entry for the worktree-config helper. A bare
 * string is the shorthand for `{ src, mode: "copy" }` with `dst === src`
 * (i.e. copy `<projectDir>/<src>` → `<worktreePath>/<src>`).
 *
 * Object form lets the caller:
 *   - point at a sibling/parent path with `src: "../foo"` — useful for
 *     scripts that live in the parent monorepo but are needed inside
 *     submodule worktrees (fabrica-v3-api's `start-api*.sh` come from
 *     the parent fabrica-v3 checkout).
 *   - place the file at a different name with `dst`.
 *   - choose `mode: "symlink"` so updates in the source location flow
 *     into every worktree automatically — right for scripts and
 *     auto-rotating configs; wrong for snapshot-style secrets.
 */
export type WorktreeConfigEntry =
  | string
  | {
      /** Path relative to `projectDir`. Can include `../` to reach the parent monorepo. */
      src: string;
      /** Path relative to the new worktree. Defaults to `src`. */
      dst?: string;
      /** "copy" snapshots; "symlink" tracks the source. Default "copy". */
      mode?: "copy" | "symlink";
    };

interface SeedResult {
  copied: string[];
  symlinked: string[];
  skipped: string[];
}

/**
 * Seed a freshly-created worktree with files that `git worktree add`
 * doesn't bring along — gitignored sops config, secrets, and start
 * scripts that the engineer would otherwise have to hand-copy before
 * running a single test.
 *
 * Renamed from `copyWorktreeConfig` (v0.9.0) to reflect that it now
 * handles symlinks too. Bare-string entries still copy, so existing
 * defaults remain backward-compatible.
 *
 * Missing source files skip silently. Per-entry errors are logged but
 * don't abort the seeding — partial success is better than refusing to
 * spawn over a single missing file. Existing destinations are
 * overwritten, so this is safe to re-run.
 */
export async function seedWorktreeConfig(
  projectDir: string,
  worktreePath: string,
  entries: readonly WorktreeConfigEntry[],
): Promise<SeedResult> {
  const { copyFileSync, mkdirSync, existsSync: exists, symlinkSync, unlinkSync, lstatSync } = await import("fs");
  const { dirname, resolve } = await import("path");
  const result: SeedResult = { copied: [], symlinked: [], skipped: [] };
  for (const entry of entries) {
    const norm =
      typeof entry === "string"
        ? { src: entry, dst: entry, mode: "copy" as const }
        : { src: entry.src, dst: entry.dst ?? entry.src, mode: entry.mode ?? "copy" };
    const srcAbs = resolve(projectDir, norm.src);
    const dstAbs = resolve(worktreePath, norm.dst);
    if (!exists(srcAbs)) {
      result.skipped.push(norm.dst);
      continue;
    }
    const dstDir = dirname(dstAbs);
    if (!exists(dstDir)) mkdirSync(dstDir, { recursive: true });
    try {
      // Clear an existing dst (file or symlink) before writing the new one.
      try {
        const stat = lstatSync(dstAbs);
        if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(dstAbs);
      } catch {
        // dst doesn't exist; nothing to clear.
      }
      if (norm.mode === "symlink") {
        symlinkSync(srcAbs, dstAbs);
        result.symlinked.push(norm.dst);
      } else {
        copyFileSync(srcAbs, dstAbs);
        result.copied.push(norm.dst);
      }
    } catch (e) {
      console.error(`[worktree] seed '${norm.dst}' (mode=${norm.mode}) from ${srcAbs} failed:`, e);
      result.skipped.push(norm.dst);
    }
  }
  return result;
}

/**
 * Backward-compatible alias for the v0.9.0 name. Same shape; entries
 * coerce through the v0.10.0 seeding pipeline.
 */
export const copyWorktreeConfig = seedWorktreeConfig;

/**
 * Default seed list per project (last path segment of `projectDir`).
 * Empty list = nothing to seed. Match is "endsWith /<key>" rather than
 * equality so it applies to direct project roots AND nested submodule
 * paths.
 *
 * fabrica-v3-api notes:
 *   - `config/age-keys.txt` + `config/local.json` are snapshot-copied
 *     (sops keys + per-machine config — engineer-local, no good reason
 *     to track changes in the main checkout).
 *   - `start-api*.sh` live in the parent fabrica-v3 monorepo, not in
 *     the fabrica-v3-api submodule. Symlinked so any update in the main
 *     checkout flows into every worktree on the next run.
 */
export const WORKTREE_CONFIG_DEFAULTS: Record<string, readonly WorktreeConfigEntry[]> = {
  "fabrica-v3-api": [
    "config/age-keys.txt",
    "config/local.json",
    { src: "../start-api.sh", mode: "symlink" },
    { src: "../start-api-worker.sh", mode: "symlink" },
    { src: "../start-api-agent.sh", mode: "symlink" },
    { src: "../start-api-worker-agent.sh", mode: "symlink" },
  ],
};

export function defaultWorktreeConfigFiles(projectDir: string): readonly WorktreeConfigEntry[] {
  for (const [key, files] of Object.entries(WORKTREE_CONFIG_DEFAULTS)) {
    if (projectDir.endsWith(`/${key}`) || projectDir.endsWith(`\\${key}`)) return files;
  }
  return [];
}
