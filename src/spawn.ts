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

import { Orchestrator } from "@agiterra/crew-tools";
import {
  generateKeyPair,
  exportPrivateKey,
  registerOrRefresh,
  sendSignedMessage,
  type KeyPair,
} from "@agiterra/wire-tools";

/**
 * The Wire broker URL a REMOTE ephemeral dials from its own machine. Cross-
 * machine agents talk to their host's LOCAL broker (e.g. patisserie on the Mini
 * listening on :9800) for low-latency outbound, NOT back to the parent's broker.
 * Override per-spawn via env.WIRE_URL if a host's local broker differs.
 */
export const REMOTE_LOCAL_BROKER_URL = "http://localhost:9800";

/**
 * Strip a leading `user@` from an ssh host, yielding a BARE host. Crew's
 * machine-table `ssh_host` carries the ssh user (e.g.
 * `tim@patisserie.tail3ef8a5.ts.net`) because crew runs `ssh <ssh_host>`
 * directly — but the dashboard attach button's WIRE_SSH_HOST convention is a
 * bare host: WireAttach.app prepends `tim@` itself, so a raw value would build
 * `ssh tim@tim@…`. Idempotent on already-bare hosts.
 * See [[reference-wireattach-clicktoattach]].
 */
export function bareSshHost(sshHost: string): string {
  return sshHost.replace(/^[^@]+@/, "");
}

/**
 * The OS account a REMOTE (cross-machine) spawn runs under. This is fleet
 * ISOLATION POLICY, not an orchestration input: a spawner picks the machine; the
 * sanctioned isolated identity underneath is fixed and inferred here — it is NOT a
 * spawn parameter (removed 2026-07-01 per Tim — a caller-supplied uid was a
 * foot-gun: omitting it silently fell back to the spawner's own uid, which is how
 * the fleet ended up running engineers as brioche-UID). Per-machine OWNERSHIP of
 * this policy (inferred + enforced machine-side, not in the orchestrator's process)
 * lands with crew-service Phase 3.
 */
export const EPHEMERAL_UID = "_ephemeral";

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
  /**
   * BARE host (no `user@`) this orchestrator runs on, ssh-reachable as
   * `tim@<host>`. Forwarded into a LOCAL spawn's WIRE_SSH_HOST so its dashboard
   * attach button can reconstruct `ssh tim@<host>` from another cockpit. Unset →
   * WIRE_SSH_HOST is empty and the button falls back to a same-machine
   * `screen -r`. REMOTE spawns derive the host from the target machine row
   * instead. See [[reference-wireattach-clicktoattach]].
   */
  wire_ssh_host?: string;
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

  // 0b. Cross-machine resolution. When opts.machine names a registered NON-LOCAL
  //     machine, this spawn goes REMOTE: crew creates the screen on that host
  //     (ssh + sudo -u run_as_uid, wired in launchAgent), the agent dials its
  //     host's local broker, and — approach A — we register its key against the
  //     remote's PUBLIC broker_url. Federation relays MESSAGES but NOT
  //     REGISTRATIONS, so the key must live on the broker the agent actually
  //     dials (the C proof-spawn's 401 was exactly this gap). Local machines
  //     (ssh_host=localhost) and no machine → unchanged local path.
  const machineRow = opts.machine
    ? deps.orchestrator.store.getMachine(opts.machine)
    : undefined;
  if (opts.machine && !machineRow) {
    throw new Error(
      `spawn[${new_agent_id}]: unknown machine '${opts.machine}' — register it first with machine_register({ name, ssh_host, broker_url }).`,
    );
  }
  const isRemote = !!machineRow && machineRow.ssh_host !== "localhost";
  // REMOTE spawns run under the sanctioned isolated account (EPHEMERAL_UID),
  // inferred here — never a caller param. LOCAL spawns run as the spawner (no sudo).
  const run_as_uid = isRemote ? EPHEMERAL_UID : undefined;
  if (isRemote && !machineRow!.broker_url) {
    throw new Error(
      `spawn[${new_agent_id}]: machine='${opts.machine}' has no broker_url — a cross-machine spawn registers the ephemeral against the remote's broker (approach A). ` +
      `Re-register it: machine_register({ name:'${opts.machine}', ssh_host:'...', broker_url:'https://<remote-public-broker>' }).`,
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

  // 2. Wire identity: sponsor a new keypair for the ephemeral.
  // Wrapped so a bare native throw here (e.g. crypto.subtle.sign on a bad
  // sponsor key, which surfaces as an empty-message "Error") names THIS step
  // instead of a useless `#run native:NN`. Carries the original via `cause`.
  //
  //    REMOTE (approach A): register against the remote machine's PUBLIC
  //    broker_url, not the parent's broker. The agent dials its host's local
  //    broker, whose key store federation does NOT populate from the parent —
  //    so the sponsoring parent registers the key THERE (parent-signed; the
  //    remote broker trusting the parent's sponsor identity over federation is
  //    exactly what the live gate proves).
  const registration_url = isRemote ? machineRow!.broker_url! : deps.wire_url;
  let new_keypair: KeyPair;
  let new_privkey_b64: string;
  try {
    new_keypair = await generateKeyPair();
    new_privkey_b64 = await exportPrivateKey(new_keypair.privateKey);
    await registerOrRefresh(
      registration_url,
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
      `spawn[${new_agent_id}]: WIRE-IDENTITY step failed (sponsor=${deps.parent_agent_id}, registration_url=${registration_url}${isRemote ? ` [remote machine '${opts.machine}']` : ""}, force_rotate=${opts.force_rotate}): ` +
      (m && m !== "Error" ? m : "(empty native error — likely crypto.subtle.sign on the sponsor's signing key; verify the sponsor's AGENT_PRIVATE_KEY is a valid sign-capable Ed25519 key)"),
      { cause: e },
    );
  }

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
    // REMOTE: dial the host's LOCAL broker (low-latency outbound); the parent's
    // broker is reachable from there only via federation. LOCAL: the parent's
    // broker as before.
    WIRE_URL: isRemote ? REMOTE_LOCAL_BROKER_URL : deps.wire_url,
    // Plugins that advertise webhook URLs to external services need the
    // public Wire URL — register_pr_webhook returned a localhost callback
    // before this propagation and GitHub rejected with 422 (Brioche 2026-
    // 05-28 papercut #1). For a remote agent the public URL is its host's
    // broker_url (where its key is registered). Else default to WIRE_URL if no
    // external URL is set, which is correct for setups without an ngrok tunnel.
    WIRE_EXTERNAL_URL: isRemote ? machineRow!.broker_url! : (deps.wire_external_url ?? deps.wire_url),
    // Placement self-report for the dashboard attach button
    // ([[reference-wireattach-clicktoattach]]): wire-tools selfReportFields()
    // forwards these into POST /agents/register, and WireAttach.app rebuilds
    // `ssh -t tim@<WIRE_SSH_HOST> "sudo -u <WIRE_RUN_AS_UID> screen -DR <screen>"`.
    // REMOTE: the target machine's BARE host (bareSshHost strips the `user@` crew's
    // ssh_host carries, else the button builds `ssh tim@tim@…`) + the per-UID
    // account we sudo into (run_as_uid, guaranteed non-empty above for remote).
    // LOCAL: the screen runs under the SPAWNER's uid (no sudo), so run_as_uid is
    // empty — reporting _ephemeral would make the attach's `sudo -u _ephemeral`
    // fail; host comes from the spawner's own env (deps.wire_ssh_host).
    WIRE_SSH_HOST: isRemote ? bareSshHost(machineRow!.ssh_host) : (deps.wire_ssh_host ?? ""),
    WIRE_RUN_AS_UID: run_as_uid ?? "",
    KNOWLEDGE_ENRICH_RULES: JSON.stringify({ ipc: { from: [parent_id] } }),
    // Per-ephemeral vault isolation for remote ephemerals ([[plan-recycle-
    // trigger]]): each gets its OWN KNOWLEDGE vault keyed by agent_id so a
    // future recycle's save->clear->boot touches only its own session-state
    // (the fleet shares one vault today → every recycle would clobber the
    // others'). The D-side hook is just this env var; the knowledge plugin
    // honors absolute KNOWLEDGE_VAULT over its $CWD/.knowledge default. Full
    // reap-cleanup + worktree-coupling land with the recycle feature.
    // Overridable: opts.env (spread below) wins.
    ...(isRemote ? { KNOWLEDGE_VAULT: `/Users/${run_as_uid}/.knowledge-vaults/${new_agent_id}` } : {}),
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

  // Remote spawns are ALWAYS headless from this orchestrator's POV — the agent's
  // screen lives on another host, so there is no local pane to attach. Any
  // placement passed for a remote spawn is ignored (force headless). Operator
  // visibility on the remote is via ssh + screen -x / crew remote attach.
  if (placement && !detached && !isRemote) {
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

  // 4b. Branch passthrough. If the caller names a branch, forward it as an
  //     AGENT_BRANCH env hint — nothing more. Bridge does NOT create worktrees,
  //     copy config, or run worktree-init: that's the agent's call (it has
  //     agency), and submodules/worktrees are a consumer's layout concern, not
  //     the generic stack's. The agent spawns in `opts.project_dir` as given
  //     and loads its plugins from that dir's installed_plugins.json entries —
  //     so the caller must spawn it in a dir that has them. (cc-launch.sh
  //     passes NO --plugin-dir, which would otherwise disable discovery and
  //     leave wire unloaded — the chronic wire-blind engineer bug.)
  if (opts.branch) env.AGENT_BRANCH = opts.branch;

  // 5. Crew launchAgent. All placement variants (including `near`) pre-create
  //    the pane in step 4; we attach POST-launch below.
  let launched;
  try {
    launched = await deps.orchestrator.launchAgent({
      env,
      runtime: opts.runtime,
      projectDir: opts.project_dir,
      prompt: opts.task,
      badge: opts.badge,
      // Cross-machine routing: when machine is non-local, launchAgent creates
      // the screen on that host via ssh + sudo -u runAsUid and stamps
      // machine_name (so the reconciler won't false-reap it). Resolved/validated
      // above; launchAgent treats a localhost machine as a normal local spawn.
      machine: opts.machine,
      runAsUid: run_as_uid,
    });
  } catch (e) {
    const m = (e as Error)?.message || String(e);
    throw new Error(
      `spawn[${new_agent_id}]: crew LAUNCH-AGENT step failed (project_dir=${opts.project_dir}, runtime=${opts.runtime}${isRemote ? `, machine='${opts.machine}' run_as_uid='${run_as_uid}' [remote]` : ""}): ` +
      (m && m !== "Error" ? m : "(empty native error from crew launchAgent — likely the terminal backend / screen creation; for remote spawns also check ssh reachability + sudo -u perms)"),
      { cause: e },
    );
  }

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
