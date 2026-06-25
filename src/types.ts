// Public types for the BridgeHook contract that integration plugins implement,
// and for the composite-function inputs/outputs. Integration plugins import
// from "@agiterra/bridge-tools/types" without pulling in runtime code.

/** Placement geometry — covers crew's full vocabulary, backend-agnostic. */
export type Placement =
  | RelativePlacement
  | ExplicitPlacement
  | NewTabPlacement
  | NewWorkspacePlacement;

export interface RelativePlacement {
  /** Pane or agent name to anchor to. */
  near: string;
  /** Side of the anchor to place at. */
  direction: "right" | "below" | "left" | "above";
  /** If true, spawn the agent without attaching to a pane (headless sub-agent). */
  detached?: boolean;
}

export interface ExplicitPlacement {
  machine?: string;
  workspace: string;
  tab: string;
  relative_to: string;
  direction: "right" | "below" | "left" | "above";
  detached?: boolean;
}

export interface NewTabPlacement {
  machine?: string;
  workspace: string;
  new_tab: string;
  detached?: boolean;
}

export interface NewWorkspacePlacement {
  machine?: string;
  new_workspace: string;
  detached?: boolean;
}

/** Sponsor key choice for the new ephemeral. */
export interface SponsorSpec {
  /** Wire identity that signs the new ephemeral's registration. Defaults to the orchestrator. */
  identity?: string;
  /** Override the env var the new ephemeral receives for parent-identity tracking. */
  parent_identity?: string;
}

/** Arguments to spawn. */
export interface SpawnOptions {
  /** Stable identifier for the new agent. Orchestrator-supplied — must be unique on Wire. */
  agent_id: string;
  /** Display name. Defaults to `agent_id`. */
  display_name?: string;
  /** Opaque role tags — forwarded to the worker via env (`AGENT_ROLES`) and audit logs. Bridge does NOT interpret these; the orchestrator owns role definitions and prompt assembly. */
  roles: string[];
  /** The fully-assembled task brief. Sent to the new agent via wire-ipc kickoff. */
  task: string;
  /** Capabilities to dispatch pre_spawn BridgeHooks for. Each capability whose hook is registered runs; missing capabilities are silently skipped. Order is preserved. */
  capabilities?: string[];
  /** Where to place the new pane (and whether to place one at all). Omit → headless. */
  placement?: Placement;
  /** Sponsor identity controls. Omit → orchestrator sponsors. */
  sponsor?: SponsorSpec;
  /** Per-spawn env overrides — fresh GH tokens, task-specific URLs, feature flags. Takes precedence over fleet defaults and hook contributions. */
  env?: Record<string, string>;
  /** Runtime to launch (e.g., "claude", "codex"). Forwarded to crew.launchAgent. */
  runtime?: string;
  /** Working directory for the spawned process — forwarded to crew.launchAgent as the spawn cwd. The agent loads its plugins from this dir's installed_plugins.json entries, so the caller must spawn it in a dir that has them (NOT a worktree subpath that doesn't). Bridge does not interpret or rewrite this path. */
  project_dir?: string;
  /**
   * Cross-machine spawn: name of a registered crew machine (machine_register)
   * to spawn ON. When it names a non-local machine (ssh_host != localhost), the
   * spawn goes REMOTE — crew creates the agent's screen there via ssh + `sudo -u
   * <run_as_uid>`, the agent runs headless (no local pane), its WIRE_URL is
   * pointed at the remote's LOCAL broker, and — approach A — its Wire identity is
   * registered against the remote machine's public `broker_url` (federation does
   * NOT relay registrations, so the key must live on the broker the agent dials).
   * Omit (or name a localhost machine) → unchanged local spawn.
   */
  machine?: string;
  /** Per-UID account to spawn the remote agent under (e.g. `_ephemeral`). REQUIRED when `machine` is non-local; ignored for local spawns. */
  run_as_uid?: string;
  /** Git branch the agent works on. Forwarded as the `AGENT_BRANCH` env hint only — bridge does NOT create a worktree. Agents manage their own worktrees (a consumer/agent concern, not the generic stack's). */
  branch?: string;
  /** Optional badge text displayed in the pane's top-right when attached. Forwarded to crew.launchAgent. */
  badge?: string;
  /** Force-rotate the new agent's Wire identity at registration. A reaped agent_id keeps its old pubkey on file, so registering a fresh keypair under that id fails with HTTP 409 `agent_exists_pubkey_mismatch`. `force_rotate` skips the existing-row check and mints a fresh keypair — permanently locking out any process still holding the previous key. Use only when re-spawning a reaped id with no live process on the old key. */
  force_rotate?: boolean;
}

/** Result of a successful spawn. */
export interface SpawnResult {
  agent_id: string;
  pane_id?: string;
  pane_name?: string;
  wire_identity: string;
  applied_capabilities: string[];
  brief_sent: boolean;
}

/** Context passed to a BridgeHook at runtime. */
export interface BridgeHookContext {
  /** Capability being requested. */
  capability: string;
  /** Stage at which the hook fires. */
  stage: BridgeHookStage;
  /** The full spawn options (or other composite-call options) the hook can read. */
  spawn?: SpawnOptions;
  /** Env map assembled so far. Hook may add to it via return value but should not mutate. */
  env_so_far: Readonly<Record<string, string>>;
}

/** Stages at which a BridgeHook can fire. v1 only ships pre_spawn; more later. */
export type BridgeHookStage = "pre_spawn";

/** Return value from a BridgeHook. */
export interface BridgeHookContribution {
  /** Env vars the hook contributes. Merged into the spawn env in capability-iteration order. */
  env?: Record<string, string>;
  /** Diagnostic message for logs/compose-brief output. */
  note?: string;
}

/** The contract integration plugins implement. */
export interface BridgeHook {
  stage: BridgeHookStage;
  capability: string;
  run(ctx: BridgeHookContext): Promise<BridgeHookContribution> | BridgeHookContribution;
}

/**
 * Optional Role type for orchestrators who want type-safe role-file definitions.
 *
 * Role *definitions*, *composition logic*, and *role catalog* are NOT bridge's
 * responsibility — they belong to the orchestrator (Brioche). This type is
 * exported only as a convenience for orchestrators who choose to write their
 * role files in TypeScript and want IDE help. bridge.spawn does not import,
 * resolve, or merge Role objects.
 */
export interface Role {
  name: string;
  description: string;
  capabilities?: string[];
  plugins?: string[];
  vault_scope?: "per-task" | "per-role" | "per-machine";
  prompt_fragment?: string;
  env_defaults?: Record<string, string>;
  pre_spawn_hooks?: string[];
}

/** Fleet defaults stored in wire.db plugin_settings (namespace=`bridge`). */
export interface FleetDefaults {
  apply_operator_relay: boolean;
  default_vault_scope: "per-task" | "per-role" | "per-machine";
  default_sponsor: "orchestrator" | string;
  default_backend?: "cmux" | "iterm";
  default_placement_strategy: "next-available" | "right-of-current" | string;
  env_defaults: Record<string, string>;
  conflict_policy: "warn" | "fail";
}
