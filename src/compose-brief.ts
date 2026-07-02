// composeBrief — dry-run inspection of what spawn WOULD do without spawning.
//
// Returns the assembled env, resolved placement, and hook-dispatch plan that
// spawn would produce given the same SpawnOptions. Lets the orchestrator
// verify before committing — useful when integrating a new role set or
// when adding a new capability to the hook registry.
//
// Note: composeBrief does NOT call hooks. It only reports which hooks WOULD
// run for the declared capabilities. Hooks may have side effects (e.g.,
// minting a GitHub token); we don't want a dry-run to mint a token. The hook
// run-plan is informational only.

import type { SpawnOptions, BridgeHook } from "./types.js";
import { paneNear, type PaneNearResult } from "./pane-near.js";
import type { Orchestrator } from "@agiterra/crew-tools";

export interface ComposeBriefResult {
  agent_id: string;
  display_name: string;
  roles: string[];
  task: string;
  capabilities: string[];
  /** Capabilities with a registered pre_spawn hook. The hooks themselves are NOT invoked. */
  hooks_that_would_run: string[];
  /** Capabilities declared but with no registered hook. Silently skipped at spawn time. */
  capabilities_without_hooks: string[];
  /** Env map preview — excludes hook contributions (since hooks are not called). */
  env_preview: Record<string, string>;
  /** Resolved placement spec, if relative placement was supplied. */
  placement: PaneNearResult | undefined;
  /** Notes / warnings the orchestrator should review. */
  notes: string[];
}

export interface ComposeBriefDeps {
  orchestrator: Orchestrator;
  wire_url: string;
  parent_agent_id: string;
}

export function composeBrief(
  opts: SpawnOptions,
  deps: ComposeBriefDeps,
  registry: ReadonlyMap<string, BridgeHook>,
): ComposeBriefResult {
  const notes: string[] = [];
  const display_name = opts.display_name ?? opts.agent_id;

  const hooks_that_would_run: string[] = [];
  const capabilities_without_hooks: string[] = [];
  for (const cap of opts.capabilities ?? []) {
    if (registry.has(cap)) hooks_that_would_run.push(cap);
    else capabilities_without_hooks.push(cap);
  }
  if (capabilities_without_hooks.length > 0) {
    notes.push(
      `Capabilities declared but with no registered hook (silently skipped at spawn): ${capabilities_without_hooks.join(", ")}. Install the corresponding bridge-X integration plugin to enable.`,
    );
  }

  // Mirror spawn's machine refusal: spawns go through THIS machine's
  // crew-service; the target account is the SERVICE's decision
  // (CREW_SVC_SPAWN_UID), never resolvable in a dry-run.
  if (opts.machine) {
    notes.push(
      `machine='${opts.machine}' is no longer supported — spawn would THROW. Spawns go through this machine's ` +
      `crew-service (crew.agent_spawn), which owns the spawn account and screen; cross-machine spawn RPC lands with wire v1.1.`,
    );
  }

  const env_preview: Record<string, string> = {
    AGENT_ID: opts.agent_id,
    AGENT_NAME: display_name,
    // AGENT_PRIVATE_KEY would be minted at spawn time — placeholder here.
    AGENT_PRIVATE_KEY: "<minted at spawn>",
    AGENT_PARENT: opts.sponsor?.parent_identity ?? deps.parent_agent_id,
    AGENT_ROLES: opts.roles.join(","),
    WIRE_URL: deps.wire_url,
    // Placement self-report ([[reference-wireattach-clicktoattach]]) — mirrors
    // spawn(): the bridge contributes its own host + empty uid; when the
    // crew-service sudos into a spawn account (CREW_SVC_SPAWN_UID) it OVERLAYS
    // WIRE_RUN_AS_UID/WIRE_SSH_HOST/KNOWLEDGE_VAULT with authoritative values —
    // not resolvable in this dry-run preview.
    WIRE_SSH_HOST: "<spawner WIRE_SSH_HOST; service overlays for sudo'd spawns>",
    WIRE_RUN_AS_UID: "<service-stamped when it sudos; else empty>",
    ...(opts.env ?? {}),
  };

  let placement: PaneNearResult | undefined;
  const p = opts.placement;
  notes.push(
    "Placement applies only when the service spawns under the bridge's own account — a sudo'd spawn " +
    "(CREW_SVC_SPAWN_UID set, e.g. _ephemeral) is forced headless and placement is ignored.",
  );
  if (p && "detached" in p && p.detached) {
    notes.push("Placement is detached — no pane will be created.");
  } else if (p && "near" in p) {
    try {
      placement = paneNear(
        { near: p.near, direction: p.direction },
        { orchestrator: deps.orchestrator },
      );
    } catch (e) {
      notes.push(`Placement preview failed: ${(e as Error).message}`);
    }
  } else if (p && "relative_to" in p) {
    notes.push(
      `Explicit placement: pane will be created in tab '${p.tab}' ${p.direction} of '${p.relative_to}'.`,
    );
  } else if (p && "new_tab" in p) {
    notes.push(`New tab placement: tab '${p.new_tab}' will be created with a default pane.`);
  } else if (p && "new_workspace" in p) {
    notes.push(
      `New workspace placement: workspace/tab '${p.new_workspace}' will be created with a default pane.`,
    );
  }

  return {
    agent_id: opts.agent_id,
    display_name,
    roles: opts.roles,
    task: opts.task,
    capabilities: opts.capabilities ?? [],
    hooks_that_would_run,
    capabilities_without_hooks,
    env_preview,
    placement,
    notes,
  };
}
