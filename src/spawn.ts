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
//   4. crew.agent_spawn RPC to this machine's crew-service (deps.crew_svc_dest)
//      → the SERVICE creates the screen and picks the OS account
//        (CREW_SVC_SPAWN_UID); the bridge never touches uid policy. The
//        service also stamps uid-derived env (WIRE_RUN_AS_UID, WIRE_SSH_HOST,
//        KNOWLEDGE_VAULT default) — only it knows the account.
//   5. Placement: attach the spawned agent to a pane — LOCAL same-uid spawns
//      only (a sudo'd spawn's screen belongs to another account; forced
//      headless, placement ignored, exactly like remote spawns before it)
//   6. wire-ipc kickoff: send a signed `bridge.kickoff` envelope to the new
//      ephemeral carrying the task brief
//   7. Return SpawnResult with the new agent's id, wire identity, applied
//      capabilities, and brief-sent flag.
//
// Notes:
//   - Roles are opaque tags. Forwarded as AGENT_ROLES env var; bridge does not
//     interpret them. The orchestrator owns prompt assembly upstream of spawn;
//     by the time we're here, `task` is the finished brief.
//   - CROSS-MACHINE spawns are NOT supported through the bridge (the
//     `machine` param is refused): crew-service writes require a broker-
//     verified sender registered on the TARGET machine's broker, and
//     forwarded (cross-broker) frames never carry a verified pubkey — by
//     design, fail closed. The old orchestrator-embedded ssh/sudo remote
//     path (run_as_uid and all) is DELETED, not routed around. Cross-broker
//     RPC lands with wire v1.1's ForwardedEnvelope.
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

import { Orchestrator } from "@agiterra/crew-tools";
import {
  generateKeyPair,
  exportPrivateKey,
  registerOrRefresh,
  sendSignedMessage,
  type KeyPair,
} from "@agiterra/wire-tools";

/**
 * How long a crew.agent_spawn RPC may take end-to-end. The service's
 * launchAgent includes the credential check, screen creation, CC boot, and
 * the dev-channel confirm settle — tens of seconds on a quiet box and
 * 2–3 minutes on a paging one (tortelli, 2026-09-04: the 120 s budget
 * expired at 16:27:00Z, the service replied at 16:27:27Z, the lane was
 * live). A timeout here must never read as "not spawned".
 */
export const SPAWN_RPC_TIMEOUT_MS = 300_000;

/** The shape crew.agent_spawn replies with (crew-service methods.ts). */
export type CrewSpawnReply = {
  machine: string;
  spawned: string;
  screen_name: string;
  screen_pid?: number;
  run_as_uid: string | null;
  requested_by?: string;
};

/** Runtime dependencies spawn needs but doesn't own. The MCP adapter constructs these once at boot and passes them in. */
export interface SpawnDeps {
  /** Crew orchestrator instance. Holds the terminal backend + state DB. Used for PANES/placement only — agent lifecycle goes through crew-service. */
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
  /**
   * BARE host (no `user@`) this orchestrator runs on, ssh-reachable as
   * `tim@<host>`. Forwarded into a spawn's WIRE_SSH_HOST so its dashboard
   * attach button can reconstruct `ssh tim@<host>` from another cockpit.
   * Unset → WIRE_SSH_HOST is empty and the button falls back to a
   * same-machine `screen -r`. For sudo'd spawns the crew-service overlays
   * its own CREW_SVC_SSH_HOST. See [[reference-wireattach-clicktoattach]].
   */
  wire_ssh_host?: string;
  /** Orchestrator's agent ID — used as the sponsoring identity for the new ephemeral. */
  parent_agent_id: string;
  /** Orchestrator's signing key — signs the registration request. */
  parent_signing_key: CryptoKey;
  /**
   * Wire RPC requester (the adapter owns the transport — a per-call
   * WireConnection under the parent identity). Called with the crew-service
   * dest, "crew.agent_spawn", params, and a timeout.
   */
  rpc_request: (dest: string, method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  /**
   * THIS machine's crew-service Wire id, e.g. "crew-svc@patisserie"
   * (convention: crew-svc@<WIRE_INSTANCE_NAME normalized>). Every spawn
   * lands there; the service owns account policy and screen creation.
   */
  crew_svc_dest: string;
}

/**
 * Spawn a new agent with the given roles, task, and placement.
 *
 * @param opts spawn arguments
 * @param deps runtime deps (orchestrator, wire url, parent identity + signing key, crew-service RPC)
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

  // 0. Guard: refuse a git-worktree subpath as project_dir. The agent loads its
  //    plugins from project_dir's installed_plugins.json; a worktree subpath
  //    (`.../worktrees/<branch>`) usually lacks the wire/wire-ipc entries, so the
  //    agent launches IPC-blind (in + out dead) with NO error — the silent
  //    failure Brioche hit spawning into fabrica-v3/worktrees/<branch>. Bridge
  //    stays worktree-agnostic (it does not rewrite paths or seed config — a
  //    consumer-layout concern), so the fix is to fail LOUD: spawn at the repo
  //    ROOT and pass `branch`; the agent self-creates its worktree.
  if (opts.project_dir && /(^|\/)worktrees\//.test(opts.project_dir)) {
    throw new Error(
      `spawn: project_dir '${opts.project_dir}' looks like a git-worktree subpath (contains '/worktrees/'). ` +
      `The agent loads plugins from this dir's installed_plugins.json, and worktree subpaths usually lack the ` +
      `wire/wire-ipc entries — so it would launch IPC-blind with no error. Spawn at the repo ROOT and pass ` +
      `branch='<branch>'; the agent self-creates its worktree (the documented pattern).`,
    );
  }

  // 0b. Machine targeting is refused — spawns land on THIS machine's
  //     crew-service. A cross-machine spawn needs a writer identity
  //     registered on the TARGET broker (verified-sender gate, fail closed);
  //     the old bridge-embedded ssh/sudo remote path is deleted, not hidden.
  if (opts.machine) {
    throw new Error(
      `spawn[${new_agent_id}]: machine='${opts.machine}' is no longer supported — spawns go through this ` +
      `machine's crew-service (${deps.crew_svc_dest}), which owns the spawn account and screen. To spawn on ` +
      `another machine, ask an orchestrator ON that machine (its crew-service only accepts writers registered ` +
      `on its own broker). Cross-broker spawn RPC lands with wire v1.1 ForwardedEnvelope.`,
    );
  }

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

  // 2. Wire identity: sponsor a new keypair for the ephemeral, registered on
  //    the LOCAL broker — the same broker the spawned agent dials and the same
  //    one whose crew-service will create its screen.
  // Wrapped so a bare native throw here (e.g. crypto.subtle.sign on a bad
  // sponsor key, which surfaces as an empty-message "Error") names THIS step
  // instead of a useless `#run native:NN`. Carries the original via `cause`.
  let new_keypair: KeyPair;
  let new_privkey_b64: string;
  try {
    new_keypair = await generateKeyPair();
    new_privkey_b64 = await exportPrivateKey(new_keypair.privateKey);
    await registerOrRefresh(
      deps.wire_url,
      deps.parent_agent_id,
      deps.parent_signing_key,
      new_agent_id,
      display_name,
      // force_rotate lets the composite re-spawn a reaped agent_id in one call —
      // without it, a fresh keypair under an id whose old pubkey is still on file
      // 409s (agent_exists_pubkey_mismatch), forcing a register_agent({force_rotate})
      // dance first. Off by default (only mint-over an existing identity on request).
      { pubkey: new_keypair.publicKey, force_rotate: opts.force_rotate },
    );
  } catch (e) {
    const m = (e as Error)?.message || String(e);
    throw new Error(
      `spawn[${new_agent_id}]: WIRE-IDENTITY step failed (sponsor=${deps.parent_agent_id}, registration_url=${deps.wire_url}, force_rotate=${opts.force_rotate}): ` +
      (m && m !== "Error" ? m : "(empty native error — likely crypto.subtle.sign on the sponsor's signing key; verify the sponsor's AGENT_PRIVATE_KEY is a valid sign-capable Ed25519 key)"),
      { cause: e },
    );
  }

  // 3. Assemble env. Precedence (lowest → highest): hook contributions,
  //    bridge-required identity vars, per-spawn env overrides. (The crew-
  //    service overlays uid-derived vars on top — WIRE_RUN_AS_UID/
  //    WIRE_SSH_HOST when it sudos, KNOWLEDGE_VAULT default — because only
  //    it knows the spawn account.)
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
    // Placement self-report for the dashboard attach button
    // ([[reference-wireattach-clicktoattach]]): wire-tools selfReportFields()
    // forwards these into POST /agents/register, and WireAttach.app rebuilds
    // `ssh -t tim@<WIRE_SSH_HOST> "sudo -u <WIRE_RUN_AS_UID> screen -DR <screen>"`.
    // The bridge contributes its own host and an EMPTY uid (same-uid spawns
    // need no sudo); when the service sudos into a spawn account it overlays
    // both with authoritative values.
    WIRE_SSH_HOST: deps.wire_ssh_host ?? "",
    WIRE_RUN_AS_UID: "",
    KNOWLEDGE_ENRICH_RULES: JSON.stringify({ ipc: { from: [parent_id] } }),
    ...(opts.env ?? {}),
  };

  // 3b. Branch passthrough. If the caller names a branch, forward it as an
  //     AGENT_BRANCH env hint — nothing more. Bridge does NOT create worktrees,
  //     copy config, or run worktree-init: that's the agent's call (it has
  //     agency), and submodules/worktrees are a consumer's layout concern, not
  //     the generic stack's. The agent spawns in `opts.project_dir` as given
  //     and loads its plugins from that dir's installed_plugins.json entries —
  //     so the caller must spawn it in a dir that has them. (cc-launch.sh
  //     passes NO --plugin-dir, which would otherwise disable discovery and
  //     leave wire unloaded — the chronic wire-blind engineer bug.)
  if (opts.branch) env.AGENT_BRANCH = opts.branch;

  // 4. crew.agent_spawn RPC. The service creates the screen, picks the
  //    account, and returns the crews.db row identity.
  let launched: CrewSpawnReply;
  try {
    launched = (await deps.rpc_request(
      deps.crew_svc_dest,
      "crew.agent_spawn",
      {
        env,
        runtime: opts.runtime,
        project_dir: opts.project_dir,
        prompt: opts.task,
        badge: opts.badge,
      },
      SPAWN_RPC_TIMEOUT_MS,
    )) as CrewSpawnReply;
  } catch (e) {
    const m = (e as Error)?.message || String(e);
    if (/timed out/i.test(m)) {
      // The service does not cancel on the caller's timeout: the spawn is usually still
      // completing. Say so, and name the check — a re-spawn here burns the name.
      throw new Error(
        `spawn[${new_agent_id}]: crew.agent_spawn RPC timed out after ${SPAWN_RPC_TIMEOUT_MS / 1000}s but the service may STILL be completing it ` +
        `(a paging host spawns in 2–3 min). Do NOT re-spawn: run agent_list (or read crews.db) for '${new_agent_id}' first; ` +
        `if a row with a screen_pid appears within a few minutes the spawn succeeded and only this reply was lost. dest=${deps.crew_svc_dest}.`,
        { cause: e },
      );
    }
    throw new Error(
      `spawn[${new_agent_id}]: crew.agent_spawn RPC failed (dest=${deps.crew_svc_dest}, project_dir=${opts.project_dir}, runtime=${opts.runtime}): ` +
      (m && m !== "Error" ? m : "(empty error from the spawn RPC)") +
      ` — check the crew-service is up (crew.ping), '${deps.parent_agent_id}' is in its CREW_SVC_WRITERS, and this bridge's broker is the service's broker (writes refuse cross-broker frames).`,
      { cause: e },
    );
  }

  // 5. Placement. A sudo'd spawn's screen belongs to another OS account —
  //    no local pane can attach it (forced headless, placement ignored;
  //    operator visibility is the dashboard attach button / crew remote
  //    attach). Same-uid spawns attach exactly as before, resolved
  //    POST-launch now that the RPC told us which case we're in.
  const placement = opts.placement;
  const detached = placement && "detached" in placement && placement.detached === true;
  if (placement && !detached && !launched.run_as_uid) {
    let attach_pane: string | undefined;
    if ("near" in placement) {
      // Resolve `near` to an anchor pane (pane name OR agent name → agent's
      // attached pane), then split a new pane beside it.
      let anchorPane = deps.orchestrator.store.getPane(placement.near);
      if (!anchorPane) {
        const anchorAgent = deps.orchestrator.store.getAgent(placement.near);
        if (anchorAgent?.pane) anchorPane = deps.orchestrator.store.getPane(anchorAgent.pane);
      }
      if (!anchorPane) {
        throw new Error(
          `spawn: agent ${launched.spawned} launched HEADLESS — near='${placement.near}' is neither a pane name nor an agent attached to a pane. Attach manually or handoff().`,
        );
      }
      const new_pane = await deps.orchestrator.createPane(
        anchorPane.tab,
        undefined,
        placement.direction,
        anchorPane.name,
      );
      attach_pane = new_pane.name;
    } else if ("relative_to" in placement) {
      const tab = deps.orchestrator.store.getTab(placement.tab);
      if (!tab) throw new Error(`spawn: agent ${launched.spawned} launched HEADLESS — explicit placement tab '${placement.tab}' does not exist`);
      const anchor = deps.orchestrator.store.getPane(placement.relative_to);
      if (!anchor || anchor.tab !== placement.tab) {
        throw new Error(
          `spawn: agent ${launched.spawned} launched HEADLESS — explicit placement anchor pane '${placement.relative_to}' not found in tab '${placement.tab}'`,
        );
      }
      const new_pane = await deps.orchestrator.createPane(
        placement.tab,
        undefined,
        placement.direction === "right" || placement.direction === "left" ? "right" : "below",
        placement.relative_to,
      );
      attach_pane = new_pane.name;
    } else if ("new_tab" in placement) {
      const tab = await deps.orchestrator.createTab(placement.new_tab);
      attach_pane = tab.pane?.name;
    } else if ("new_workspace" in placement) {
      // crew's createTab doubles as workspace creation in cmux; in iTerm it
      // creates a tab in the current window. Refine if/when crew exposes a
      // dedicated new-workspace primitive.
      const tab = await deps.orchestrator.createTab(placement.new_workspace);
      attach_pane = tab.pane?.name;
    }
    if (attach_pane) {
      try {
        await deps.orchestrator.attachAgent(launched.spawned, attach_pane);
      } catch (e) {
        // Attach failure leaves the agent headless. Surface via a thrown error
        // so the caller can decide whether to handoff() the dangling agent.
        throw new Error(
          `spawn: agent ${launched.spawned} launched but failed to attach to pane '${attach_pane}': ${(e as Error).message}. Use handoff() to close cleanly.`,
        );
      }
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
    agent_id: launched.spawned,
    wire_identity: new_agent_id,
    applied_capabilities,
    brief_sent,
  };
}
