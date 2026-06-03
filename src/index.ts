// Public API surface for @agiterra/bridge-tools.
// MCP adapters (bridge-claude-code, bridge-codex) import from here and wrap
// these functions as MCP tools.

export type {
  Placement,
  RelativePlacement,
  ExplicitPlacement,
  NewTabPlacement,
  NewWorkspacePlacement,
  SponsorSpec,
  SpawnOptions,
  SpawnResult,
  BridgeHook,
  BridgeHookStage,
  BridgeHookContext,
  BridgeHookContribution,
  Role,
  FleetDefaults,
} from "./types.js";

export { spawn, type SpawnDeps } from "./spawn.js";
export { handoff, type HandoffOptions, type HandoffResult, type HandoffDeps } from "./handoff.js";
export { paneNear, type PaneNearOptions, type PaneNearResult, type PaneNearDeps } from "./pane-near.js";
export { close, type CloseOptions, type CloseResult, type CloseDeps } from "./close.js";
export { composeBrief, type ComposeBriefResult, type ComposeBriefDeps } from "./compose-brief.js";
export { health, type HealthOptions, type HealthResult, type HealthDeps } from "./health.js";
