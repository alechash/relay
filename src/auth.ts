import type { Actor } from "./context";
import type { Env } from "./env";
import { ApiError } from "./lib/errors";
import { hmac, nowIso, safeEqual, sha256Hex } from "./lib/util";
import { TOKEN_PREFIX } from "./core/tokens";

export const SESSION_COOKIE = "relay_session";
const SESSION_TTL_S = 60 * 60 * 24 * 30;

export function ownerActor(env: Env): Actor {
  return { id: "owner", name: env.OWNER_NAME || "Owner", kind: "owner", scope: "write", requiresReview: false };
}

function requireConfigured(env: Env): string {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 12) {
    throw new ApiError(
      "not_configured",
      "Relay is not configured: set the ADMIN_TOKEN secret (at least 12 characters) on the Worker, e.g. `npx wrangler secret put ADMIN_TOKEN`.",
    );
  }
  return env.ADMIN_TOKEN;
}

const sessionKey = (adminToken: string) => `relay-session:${adminToken}`;

export async function createSessionCookie(env: Env, secure: boolean): Promise<string> {
  const admin = requireConfigured(env);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const sig = await hmac(sessionKey(admin), `owner.${exp}`);
  return `${SESSION_COOKIE}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_S}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function verifySession(env: Env, value: string): Promise<boolean> {
  const admin = requireConfigured(env);
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || exp < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(sessionKey(admin), `owner.${exp}`));
}

export async function checkAdminToken(env: Env, candidate: string): Promise<boolean> {
  const admin = requireConfigured(env);
  return safeEqual(candidate, admin);
}

export interface AuthResult {
  actor: Actor;
  /** True when authenticated by cookie (browser). Mutations then require a custom header (CSRF guard). */
  cookie: boolean;
}

/**
 * Resolves the caller. Accepts, in order:
 *  - `Authorization: Bearer <ADMIN_TOKEN>` → the owner
 *  - `Authorization: Bearer rly_…` → an API/agent token
 *  - the signed session cookie set by the web UI login → the owner
 */
export async function authenticate(req: Request, env: Env, db: D1Database, waitUntil: (p: Promise<unknown>) => void): Promise<AuthResult> {
  requireConfigured(env);
  const auth = req.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m) throw new ApiError("unauthorized", "Authorization header must be `Bearer <token>`");
    const token = m[1].trim();
    if (await checkAdminToken(env, token)) return { actor: ownerActor(env), cookie: false };
    if (token.startsWith(TOKEN_PREFIX)) {
      const row: any = await db.prepare(`SELECT * FROM tokens WHERE token_hash = ?`).bind(await sha256Hex(token)).first();
      if (row && !row.revoked_at) {
        const stale = !row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 5 * 60 * 1000;
        if (stale) waitUntil(db.prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`).bind(nowIso(), row.id).run());
        return {
          actor: { id: row.id, name: row.name, kind: row.kind, scope: row.scope, requiresReview: !!row.requires_review },
          cookie: false,
        };
      }
    }
    throw new ApiError("unauthorized", "Invalid or revoked token");
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && (await verifySession(env, cookie))) return { actor: ownerActor(env), cookie: true };
  throw new ApiError("unauthorized", "Authentication required: send `Authorization: Bearer <token>` or sign in to the web UI");
}
