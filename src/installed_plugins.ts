/**
 * Ensure ~/.claude/plugins/installed_plugins.json has the entries that
 * Claude Code needs to make a spawned agent's wire channel work.
 *
 * Why this exists: Claude Code's `--dangerously-load-development-channels
 * plugin:wire@agiterra` arg only triggers channel push routing if `wire`
 * is discovered through `installed_plugins.json`. Loading it via
 * `--plugin-dir` (as `cc-launch.sh` does for other plugins) starts the
 * MCP cleanly but breaks the inbound `notifications/claude/channel`
 * delivery path — confirmed 2026-05-11 (Kouign + Eclair could send via
 * wire-ipc but received no pushed IPC) and again 2026-05-28 (today's
 * fabrica-v3-api engineer crop: financier/cruller/stollen/palmier all
 * registered, sent boot pings, but never received Brioche's replies;
 * `GET /agents` confirmed they had no active sessions).
 *
 * For a worktree spawn (e.g. `<repo>/worktrees/<branch>`), the worktree
 * directory is brand new and has zero `installed_plugins.json` entries.
 * Without intervention, Claude Code can't find wire by name → no MCP
 * server start → no SSE stream → no agent_sessions row → invisible to
 * `GET /agents` → inbound IPC drops on the floor.
 *
 * The fix is small: ensure the worktree path has an entry pointing at
 * the latest cached wire@agiterra version. Idempotent.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const PLUGIN_NAME = "wire@agiterra";
const PLUGIN_CACHE_SUBDIR = "wire";

interface InstalledPluginEntry {
  scope: "project" | "user";
  projectPath?: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

/**
 * Resolve the latest cached version directory of a given plugin name
 * under `~/.claude/plugins/cache/agiterra/<name>/`. Returns null if no
 * versioned dir is present. Uses string-natural ordering on the
 * directory names — works for typical 1.2.3 semver tags.
 */
function latestCachedVersionDir(homeDir: string, name: string): { version: string; installPath: string } | null {
  const cacheRoot = join(homeDir, ".claude", "plugins", "cache", "agiterra", name);
  if (!existsSync(cacheRoot)) return null;
  const versions: { version: string; installPath: string }[] = [];
  for (const entry of readdirSync(cacheRoot)) {
    const full = join(cacheRoot, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = join(full, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) continue;
    versions.push({ version: entry, installPath: full });
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => compareSemverLike(a.version, b.version));
  return versions[versions.length - 1];
}

function compareSemverLike(a: string, b: string): number {
  const partsA = a.replace(/^v/, "").split(/[.-]/).map((p) => /^\d+$/.test(p) ? parseInt(p, 10) : p);
  const partsB = b.replace(/^v/, "").split(/[.-]/).map((p) => /^\d+$/.test(p) ? parseInt(p, 10) : p);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i], y = partsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Ensure `wire@agiterra` is present in `installed_plugins.json` for the
 * given project directory. If the entry is already present, this is a
 * no-op. Otherwise, writes a fresh entry pointing at the latest cached
 * version.
 *
 * Returns `null` if no action was needed, or the chosen version string
 * if a new entry was written.
 *
 * Pure side-effect; safe to call repeatedly. Never modifies entries for
 * other project paths.
 */
export function ensureWireInstalledForPath(projectDir: string, homeDir?: string): string | null {
  const home = homeDir ?? process.env.HOME;
  if (!home) throw new Error("ensureWireInstalledForPath: HOME not set and no homeDir provided");

  const filePath = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(filePath)) {
    // No installed_plugins.json at all — the user's CC install is in an
    // unusual state. Don't try to bootstrap it from spawn; let CC create
    // it on first install. Spawn proceeds; engineer will be wire-blind
    // until the user runs through normal install.
    return null;
  }

  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as InstalledPluginsFile;
  const entries = data.plugins[PLUGIN_NAME] ?? [];

  // Already an entry for this project_dir? Idempotent no-op.
  const existing = entries.find((e) => e.projectPath === projectDir);
  if (existing) return null;

  // Resolve latest cached version.
  const latest = latestCachedVersionDir(home, PLUGIN_CACHE_SUBDIR);
  if (!latest) {
    // No cached wire to point at; can't help. Don't crash spawn — let
    // the engineer launch and surface the missing-plugin error itself.
    return null;
  }

  const now = new Date().toISOString();
  const newEntry: InstalledPluginEntry = {
    scope: "project",
    projectPath: projectDir,
    installPath: latest.installPath,
    version: latest.version,
    installedAt: now,
    lastUpdated: now,
  };
  data.plugins[PLUGIN_NAME] = [...entries, newEntry];

  writeFileSync(filePath, JSON.stringify(data, null, 4) + "\n", "utf-8");
  return latest.version;
}
