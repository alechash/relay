import { z } from "zod";
import type { Ctx } from "../context";

export type Access =
  /** Any authenticated caller, including read-only tokens. */
  | "read"
  /** Callers with write scope. Agent changes land in the sign-off queue. */
  | "write"
  /** Humans only (owner session, ADMIN_TOKEN, or a human token): reviews, revert, token management. */
  | "human";

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  /** snake_case; doubles as the MCP tool name. */
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** OpenAPI-style path relative to /api/v1, e.g. `/cards/{card_id}`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: Access;
  input: S;
  status?: number;
  handler: (ctx: Ctx, input: z.infer<S>) => Promise<unknown>;
}

export const op = <S extends z.ZodObject>(o: Operation<S>): Operation => o as unknown as Operation;

/** Common optional field on every mutating operation: recorded on the history event and shown during sign-off. */
export const reason = z
  .string()
  .max(2000)
  .optional()
  .describe("Why this change is being made. Stored in the history and shown when the change is reviewed. Agents should always set this.");

export const expectedVersion = z
  .number()
  .int()
  .optional()
  .describe("Optimistic concurrency: fail with 409 if the entity's current version differs.");

export const cardRef = z.string().min(1).describe("Card id (crd_…), number (42) or ref (#42)");
