import { z } from "zod";
import { operations } from "./ops";
import { jsonSchema, pathParams } from "./ops/run";

export function buildOpenApi(origin: string) {
  const paths: Record<string, any> = {};
  const errorRef = { $ref: "#/components/schemas/Error" };
  const errors = {
    "401": { description: "Not authenticated", content: { "application/json": { schema: errorRef } } },
    "403": { description: "Not allowed for this actor", content: { "application/json": { schema: errorRef } } },
    "404": { description: "Not found", content: { "application/json": { schema: errorRef } } },
    "409": { description: "Version conflict / state conflict", content: { "application/json": { schema: errorRef } } },
    "422": { description: "Validation error", content: { "application/json": { schema: errorRef } } },
  };

  for (const op of operations) {
    const pp = pathParams(op.path);
    const shape = op.input.shape as Record<string, z.ZodType>;
    const parameters: any[] = pp.map((name) => ({ name, in: "path", required: true, schema: jsonSchema(shape[name]) }));
    let requestBody: any;
    const rest = Object.keys(shape).filter((k) => !pp.includes(k));
    if (op.method === "GET" || op.method === "DELETE") {
      for (const k of rest) {
        const s = jsonSchema(shape[k]);
        parameters.push({ name: k, in: "query", required: !shape[k].safeParse(undefined).success, schema: s, description: s.description });
      }
    } else if (rest.length) {
      const bodySchema = op.input.omit(Object.fromEntries(pp.map((p) => [p, true])) as any);
      requestBody = { required: true, content: { "application/json": { schema: jsonSchema(bodySchema) } } };
    }
    const accessNote =
      op.access === "human"
        ? "\n\n**Humans only** (owner session, ADMIN_TOKEN, or a `human` token)."
        : op.access === "write"
          ? "\n\nRequires write scope. Changes by `agent` tokens are queued for sign-off."
          : "";
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = {
      operationId: op.name,
      summary: op.summary,
      description: (op.description ?? "") + accessNote + `\n\nMCP tool: \`${op.name}\``,
      tags: [op.tag],
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses: {
        [String(op.status ?? 200)]: { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
        ...errors,
      },
    };
  }

  paths["/auth/login"] = {
    post: {
      operationId: "login",
      summary: "Web UI sign-in: exchange ADMIN_TOKEN for a session cookie",
      tags: ["Meta"],
      security: [],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } } },
      responses: { "200": { description: "Signed in; sets relay_session cookie" }, "401": errors["401"] },
    },
  };
  paths["/auth/logout"] = {
    post: { operationId: "logout", summary: "Clear the web session cookie", tags: ["Meta"], security: [], responses: { "200": { description: "OK" } } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Relay API",
      version: "1.0.0",
      description:
        "Personal card/column tracker. Every operation here is also exposed as an MCP tool at `/mcp` with the same name and input.\n\n" +
        "Headers: `Authorization: Bearer <token>` (required), `X-Relay-Session` (optional: groups related changes for review), `X-Relay-Client` (optional: client name shown in history).",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "ADMIN_TOKEN, or an rly_… token created via POST /tokens" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "relay_session", description: "Set by POST /auth/login (web UI). Writes also need an X-Relay-Client header." },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
            },
          },
        },
      },
    },
    tags: ["Meta", "Boards", "Columns", "Cards", "Comments", "History", "Sign-off", "Tokens"].map((name) => ({ name })),
    paths,
  };
}
