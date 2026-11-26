import type { Env } from "./env";

export type ActorKind = "owner" | "human" | "agent";
export type Via = "web" | "api" | "mcp";

export interface Actor {
  id: string;
  name: string;
  kind: ActorKind;
  /** read = GET-style operations only; write = everything allowed for the kind. */
  scope: "read" | "write";
  /** When true, every change this actor makes lands in the sign-off queue. */
  requiresReview: boolean;
  /** Granted by a human: this token may pass skip_review: true on writes. */
  canSkipReview?: boolean;
}

export const AUTO_APPROVE_ACTIONS = ["comment", "create", "update", "move", "complete", "archive", "structure", "all"] as const;
export type AutoApproveAction = (typeof AUTO_APPROVE_ACTIONS)[number];

export interface Ctx {
  env: Env;
  db: D1Database;
  actor: Actor;
  via: Via;
  /** Free-form client description, e.g. "claude-code/2.1" (from MCP clientInfo or X-Relay-Client). */
  client: string | null;
  /** Groups related changes, e.g. one MCP connection or one agent run (X-Relay-Session). */
  sessionId: string | null;
  waitUntil: (p: Promise<unknown>) => void;
  /** Public origin of this deployment, e.g. https://relay.example.workers.dev */
  origin?: string;
  /** Request identifier recorded on every event (cf-ray when available). */
  requestId?: string | null;
  /** Set when the caller passed skip_review: true and is allowed to. */
  skipReview?: boolean;
  /** Board id → agent auto-approve policy, loaded per request for actors that require review. */
  autoApprove?: Map<string, AutoApproveAction[]>;
}

export const isHuman = (a: Actor) => a.kind === "owner" || a.kind === "human";
