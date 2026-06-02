// spawn — the marquee composite function. Collapses Brioche's 6-skill-call
// orchestration dance into a single call.
//
// Sequence executed inside this function:
//   1. Run pre_spawn BridgeHooks for each declared capability
//      → collect env contributions from each hook
//   2. Wire identity: orchestrator sponsors a new keypair for the ephemeral
//      → receives back the new private key to forward via env
//   3. Assemble final env: parent identity → hook contributions → per-spawn env
//      (per-spawn env wins on collisions)
//   4. crew.launchAgent({env, runtime, prompt: task, splitInCallerWorkspace})
//      → forwards env to the spawned process, optionally splits caller's pane
//   5. wire-ipc kickoff: send a signed `bridge.kickoff` envelope to the new
//      ephemeral carrying the task brief
//   6. Return SpawnResult with the new agent's id, wire identity, applied
//      capabilities, and brief-sent flag.
//
// Notes:
//   - Roles are opaque tags. Forwarded as AGENT_ROLES env var; bridge does not
//     interpret them. The orchestrator owns prompt assembly upstream of spawn;
//     by the time we're here, `task` is the finished brief.
//   - Placement v1: only RelativePlacement is wired (via crew's
//     splitInCallerWorkspace, supported by cmux). Explicit/new-tab/
//     new-workspace placement variants throw NotImplementedError until v0.3.
//   - Partial-failure cleanup: if wire-ipc kickoff fails after the agent
//     launches, the agent stays alive — the orchestrator can retry kickoff
//     or close manually. We do NOT auto-close on kickoff failure because the
//     agent process is already running and may have done useful work.

import type {
  SpawnOptions,
  SpawnResult,
  BridgeHook,
  BridgeHookContribution,
} from "./types.js";
import { ensureWorktree, copyWorktreeConfig, defaultWorktreeConfigFiles } from "./worktree.js";
import { ensureToolkitInstalledForPath } from "./installed_plugins.js";

import { Orchestrator } from "@agiterra/crew-tools";
import {
  generateKeyPair,
  exportPrivateKey,
  registerOrRefresh,
  sendSignedMessage,
  type KeyPair,
} from "@agiterra/wire-tools";

/** Runtime dependencies spawn needs but doesn't own. The MCP adapter constructs these once at boot and passes them in. */
export interface SpawnDeps {
  /** Crew orchestrator instance. Holds the terminal backend + state DB. */
  orchestrator: Orchestrator;
  /** Wire server URL (e.g., "http://localhost:9800"). Routed to the local broker for low-latency outbound. */
  wire_url: string;
  /**
   * Externally-reachable Wire URL (e.g. "https://the-wire.ngrok.io").
   * Plugins that advertise webhook URLs to external services
   * (github-tools/register_pr_webhook, slack-tools/register_slack_app)
   * use this. Falls back to `wire_url` if the host doesn't set it,
   * which is the right behavior on machines without an ngrok tunnel.
   */
  wire_external_url?: string;
  /** Orchestrator's agent ID — used as the sponsoring identity for the new ephemeral. */
  parent_agent_id: string;
  /** Orchestrator's signing key — signs the registration request. */
  parent_signing_key: CryptoKey;
}

/**
 * Spawn a new agent with the given roles, task, and placement.
 *
 * @param opts spawn arguments
 * @param deps runtime deps (orchestrator, wire url, parent identity + signing key)
 * @param registry pre_spawn BridgeHooks indexed by capability
 * @returns the new agent's id, wire identity, applied capabilities, brief-sent flag
 */
export async function spawn(
  opts: SpawnOptions,
  deps: SpawnDeps,
  registry: ReadonlyMap<string, BridgeHook>,
): Promise<SpawnResult> {
  const new_agent_id = opts.agent_id;
  const display_name = opts.display_name ?? new_agent_id;

  // 1. Run pre_spawn hooks for declared capabilities.
  const applied_capabilities: string[] = [];
  const hook_env: Record<string, string> = {};
  for (const cap of opts.capabilities ?? []) {
    const hook = registry.get(cap);
    if (!hook || hook.stage !== "pre_spawn") continue;
    const contribution = (await hook.run({
      capability: cap,
      stage: "pre_spawn",
      spawn: opts,
      env_so_far: hook_env,
    })) as BridgeHookContribution;
    Object.assign(hook_env, contribution.env ?? {});
    applied_capabilities.push(cap);
  }

  // 2. Wire identity: sponsor a new keypair for the ephemeral.
  const new_keypair: KeyPair = await generateKeyPair();
  const new_privkey_b64 = await exportPrivateKey(new_keypair.privateKey);
  await registerOrRefresh(
    deps.wire_url,
    deps.parent_agent_id,
    deps.parent_signing_key,
    new_agent_id,
    display_name,
    { pubkey: new_keypair.publicKey },
  );

  // 3. Assemble env. Precedence (lowest → highest): hook contributions,
  //    bridge-required identity vars, per-spawn env overrides.
  //
  // KNOWLEDGE_ENRICH_RULES default: the spawned ephemeral auto-drains IPCs
  // from its parent into context (via knowledge plugin's channel-enrichment
  // UserPromptSubmit hook). Without this, ephemerals could SEND IPCs but
  // wouldn't react to inbound — Brioche's 2026-05-26 spawn batch (eclair,
  // beignet, profiterole, tarte) hit this and sat idle at bare prompts
  // while Brioche's IPCs piled up unread. Macaron (resumed via crew
  // agent_resume, env hand-assembled) had this set and worked correctly.
  // Per-spawn env overrides can still replace this default.
  const parent_id = opts.sponsor?.parent_identity ?? deps.parent_agent_id;
  const env: Record<string, string> = {
    ...hook_env,
    AGENT_ID: new_agent_id,
    AGENT_NAME: display_name,
    AGENT_PRIVATE_KEY: new_privkey_b64,
    AGENT_PARENT: parent_id,
    AGENT_ROLES: opts.roles.join(","),
    WIRE_URL: deps.wire_url,
    // Plugins that advertise webhook URLs to external services need the
    // public Wire URL — register_pr_webhook returned a localhost callback
    // before this propagation and GitHub rejected with 422 (Brioche 2026-
    // 05-28 papercut #1). Default to WIRE_URL if no external URL is set,
    // which is correct for setups without an ngrok tunnel.
    WIRE_EXTERNAL_URL: deps.wire_external_url ?? deps.wire_url,
    KNOWLEDGE_ENRICH_RULES: JSON.stringify({ ipc: { from: [parent_id] } }),
    ...(opts.env ?? {}),
  };

  // 4. Resolve placement. Four variants supported:
  //    - RelativePlacement: anchor pane resolved from `near` (pane name or agent
  //      name) → createPane + attachAgent POST-launch. Earlier versions used
  //      crew's splitInCallerWorkspace mechanism but that's cmux-only — iTerm
  //      silently no-ops, stranding the agent headless (eclair/beignet/
  //      profiterole on 2026-05-26).
  //    - ExplicitPlacement: pane inside a specific tab — created POST-launch, then attachAgent
  //    - NewTabPlacement: new tab in (current) workspace — created POST-launch, then attachAgent
  //    - NewWorkspacePlacement: new workspace (cmux) / window (iTerm) — approximated as a new tab POST-launch
  //
  // Detached (any variant): skip pane creation/attach entirely.
  const placement = opts.placement;
  const detached = placement && "detached" in placement && placement.detached === true;
  // Post-launch placement: { tab name to attach to, optional pane name to attach to }
  let post_launch_attach: { tab: string; pane?: string } | undefined;

  if (placement && !detached) {
    if ("near" in placement) {
      // Resolve `near` to an anchor pane (pane name OR agent name → agent's
      // attached pane). Then use the same createPane + attachAgent path as
      // explicit placement.
      let anchorPane = deps.orchestrator.store.getPane(placement.near);
      if (!anchorPane) {
        const anchorAgent = deps.orchestrator.store.getAgent(placement.near);
        if (anchorAgent?.pane) anchorPane = deps.orchestrator.store.getPane(anchorAgent.pane);
      }
      if (!anchorPane) {
        throw new Error(
          `spawn: near='${placement.near}' is neither a pane name nor an agent attached to a pane`,
        );
      }
      const new_pane = await deps.orchestrator.createPane(
        anchorPane.tab,
        undefined,
        placement.direction,
        anchorPane.name,
      );
      post_launch_attach = { tab: anchorPane.tab, pane: new_pane.name };
    } else if ("relative_to" in placement) {
      const tab = deps.orchestrator.store.getTab(placement.tab);
      if (!tab) throw new Error(`spawn: explicit placement tab '${placement.tab}' does not exist`);
      const anchor = deps.orchestrator.store.getPane(placement.relative_to);
      if (!anchor || anchor.tab !== placement.tab) {
        throw new Error(
          `spawn: explicit placement anchor pane '${placement.relative_to}' not found in tab '${placement.tab}'`,
        );
      }
      const new_pane = await deps.orchestrator.createPane(
        placement.tab,
        undefined,
        placement.direction === "right" || placement.direction === "left" ? "right" : "below",
        placement.relative_to,
      );
      post_launch_attach = { tab: placement.tab, pane: new_pane.name };
    } else if ("new_tab" in placement) {
      const tab = await deps.orchestrator.createTab(placement.new_tab);
      post_launch_attach = { tab: tab.name, pane: tab.pane?.name };
    } else if ("new_workspace" in placement) {
      // crew's createTab doubles as workspace creation in cmux; in iTerm it
      // creates a tab in the current window. Refine if/when crew exposes a
      // dedicated new-workspace primitive.
      const tab = await deps.orchestrator.createTab(placement.new_workspace);
      post_launch_attach = { tab: tab.name, pane: tab.pane?.name };
    }
  }

  // 4b. Worktree isolation. When `branch` is set and `worktree !== false`,
  //     create `<project_dir>/worktrees/<branch>` so concurrent agents in
  //     the same repo don't clobber each other's uncommitted work via git
  //     checkout. Brioche's 2026-05-26 incident: Eclair (ENG-3180) and
  //     Profiterole (ENG-3205) shared fabrica-v3-api project_dir; Profiterole's
  //     checkout discarded ~600 lines of Eclair's uncommitted code.
  let resolved_project_dir = opts.project_dir;
  if (opts.branch && opts.worktree !== false && opts.project_dir) {
    resolved_project_dir = await ensureWorktree(opts.project_dir, opts.branch);
    env.AGENT_BRANCH = opts.branch;
    // Copy known gitignored config (sops keys, local overrides) from the
    // parent project into the new worktree. fabrica-v3-api spawns hit
    // this 2026-05-28: services with module-load sops-decrypt threw on
    // any spec import until the engineer manually copied the files.
    const configFiles = defaultWorktreeConfigFiles(opts.project_dir);
    if (configFiles.length > 0) {
      try {
        const seeded = await copyWorktreeConfig(opts.project_dir, resolved_project_dir, configFiles);
        // Surface real seed FAILURES (fs/permission errors) distinctly from
        // legitimately-absent sources. A silent copy failure is what made the
        // missing-secrets bug invisible (Brioche crop 2026-06-01) — log it loud
        // so it lands in bridge's mcp-tee'd stderr for RCA.
        if (seeded.failed.length > 0) {
          console.error(
            `[bridge.spawn] worktree seed FAILED for '${resolved_project_dir}': [${seeded.failed.join(", ")}] — engineer may hit missing secrets/config. ` +
              `copied=[${seeded.copied.join(", ")}] symlinked=[${seeded.symlinked.join(", ")}] absent=[${seeded.skipped.join(", ")}]`,
          );
        }
      } catch (e) {
        console.error(`[bridge.spawn] copyWorktreeConfig failed for '${resolved_project_dir}':`, e);
      }
    }
  } else if (opts.branch) {
    env.AGENT_BRANCH = opts.branch;
  }

  // 4c. Root-discovery plugin loading for Claude Code spawns (refined option
  //     A, 2026-05-29). cc-launch.sh's prior approach loaded the toolkit via
  //     --plugin-dir and left wire to --dangerously-load-development-channels;
  //     but passing --plugin-dir makes CC skip installed_plugins.json
  //     discovery entirely, so wire never loaded — the agent could send via
  //     wire-ipc but had no wire channel, no dashboard presence, no inbound
  //     IPC (Eclair, 2026-05-29; same signature as financier/cruller/stollen/
  //     palmier 2026-05-28). The v0.8.0 ensureWireInstalledForPath fix was
  //     necessary but insufficient — discovery is off whenever --plugin-dir
  //     is present.
  //
  //     The fix: launch CC from the project ROOT (a real project dir we
  //     populate with toolkit entries) with NO --plugin-dir, so CC loads the
  //     whole toolkit — wire included, with channel routing — via discovery.
  //     cc-launch.sh keys off AGENT_PROJECT_ROOT to enter this mode. The
  //     engineer cd's into its pre-made worktree ($AGENT_WORKTREE) first;
  //     plugins stay loaded across the cd. Codex spawns are unaffected (they
  //     load via per-spawn config.toml, not installed_plugins.json).
  const isClaudeCode = (opts.runtime ?? "claude-code") === "claude-code";
  let launchProjectDir = resolved_project_dir;
  let launchPrompt = opts.task;

  if (isClaudeCode && opts.project_dir) {
    try {
      const added = ensureToolkitInstalledForPath(opts.project_dir);
      if (added.length > 0) {
        console.error(
          `[bridge.spawn] toolkit entries added for root '${opts.project_dir}': ${added.join(", ")}`,
        );
      }
    } catch (e) {
      // Additive best-effort — never fail the spawn. Worst case the engineer
      // launches with whatever the root already had.
      console.error(
        `[bridge.spawn] ensureToolkitInstalledForPath failed for '${opts.project_dir}':`,
        e,
      );
    }
    env.AGENT_PROJECT_ROOT = opts.project_dir;
    launchProjectDir = opts.project_dir; // launch from root for reliable discovery
    if (resolved_project_dir && resolved_project_dir !== opts.project_dir) {
      env.AGENT_WORKTREE = resolved_project_dir;
      // Deterministic preamble: the engineer must work in its isolated
      // worktree, but CC launched from the root for plugin discovery.
      launchPrompt =
        `Your isolated git worktree is at ${resolved_project_dir} (also in $AGENT_WORKTREE). ` +
        `cd into it before doing any work — your plugins are already loaded and stay loaded across the cd.\n\n` +
        opts.task;
    }
  }

  // 5. Crew launchAgent. All placement variants (including `near`) pre-create
  //    the pane in step 4; we attach POST-launch below.
  const launched = await deps.orchestrator.launchAgent({
    env,
    runtime: opts.runtime,
    projectDir: launchProjectDir,
    prompt: launchPrompt,
    badge: opts.badge,
  });

  if (post_launch_attach?.pane) {
    try {
      await deps.orchestrator.attachAgent(launched.id, post_launch_attach.pane);
    } catch (e) {
      // Attach failure leaves the agent headless. Surface via a thrown error
      // so the caller can decide whether to handoff() the dangling agent.
      throw new Error(
        `spawn: agent ${launched.id} launched but failed to attach to pane '${post_launch_attach.pane}': ${(e as Error).message}. Use handoff() to close cleanly.`,
      );
    }
  }

  // 6. Wire-ipc kickoff: send the task brief on bridge.kickoff topic.
  //    If this fails, the agent is alive but unbriefed — return brief_sent=false
  //    rather than unwinding (the agent process is real work in flight).
  let brief_sent = false;
  try {
    await sendSignedMessage(
      deps.wire_url,
      deps.parent_agent_id,
      deps.parent_signing_key,
      "bridge.kickoff",
      { task: opts.task, roles: opts.roles, applied_capabilities },
      new_agent_id,
    );
    brief_sent = true;
  } catch (_err) {
    // Surface the failure via brief_sent=false; caller decides retry.
    brief_sent = false;
  }

  return {
    agent_id: launched.id,
    wire_identity: new_agent_id,
    applied_capabilities,
    brief_sent,
  };
}
