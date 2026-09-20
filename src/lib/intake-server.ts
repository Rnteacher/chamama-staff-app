import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveIntakeState,
  hashIntakeToken,
  type IntakeOverview,
} from "@/lib/intake-token";

/**
 * Server-side helpers for the PUBLIC intake page (anon Supabase client —
 * never service_role, never staff auth).
 *
 * Every failed RPC is logged SERVER-SIDE with safe metadata only:
 * rpc name, PostgREST error code/message/details, token LENGTH and a short
 * hash prefix. The raw token is NEVER logged.
 */

interface RpcErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

function logIntakeRpcError(
  rpc: string,
  token: string,
  error: RpcErrorLike | null,
  supabaseHost: string | null
): void {
  // raw token is never logged — only its length and hash prefix
  console.error(
    `[intake] RPC ${rpc} failed: ${JSON.stringify({
      rpc,
      code: error?.code ?? null,
      message: error?.message ?? null,
      details: error?.details ?? null,
      hint: error?.hint ?? null,
      token_length: token.length,
      token_hash_prefix: token ? hashIntakeToken(token).slice(0, 12) : null,
      supabase_host: supabaseHost, // hostname only — verifies which project/env is used
    })}`
  );
}

function supabaseHost(supabase: SupabaseClient): string | null {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

/** Defensive parse: some deployments may deliver the jsonb scalar as text. */
function parseMaybeStringData(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

/** Overview: ALWAYS resolves to a strict state (never throws, never invalid-on-error). */
export async function fetchIntakeOverview(
  supabase: SupabaseClient,
  token: string
): Promise<IntakeOverview> {
  const { data, error } = await supabase.rpc("public_intake_overview", {
    p_token: token,
  });
  if (error) {
    logIntakeRpcError("public_intake_overview", token, error, supabaseHost(supabase));
    return resolveIntakeState(null); // → technical-error state
  }
  const state = resolveIntakeState(parseMaybeStringData(data));
  if (state.status === "error") {
    logIntakeRpcError("public_intake_overview", token, null, supabaseHost(supabase));
  }
  return state;
}

/** Majors list for the wizard (empty on failure — the overview gate already passed). */
export async function fetchIntakeMajors(
  supabase: SupabaseClient,
  token: string
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.rpc("public_intake_majors", {
    p_token: token,
  });
  if (error) {
    logIntakeRpcError("public_intake_majors", token, error, supabaseHost(supabase));
    return [];
  }
  const parsed = parseMaybeStringData(data);
  return Array.isArray(parsed) ? (parsed as { id: string; name: string }[]) : [];
}

/** Masters list for the wizard: ACTIVE staff, name only (empty on failure). */
export async function fetchIntakeMasters(
  supabase: SupabaseClient,
  token: string
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.rpc("public_intake_masters", {
    p_token: token,
  });
  if (error) {
    logIntakeRpcError("public_intake_masters", token, error, supabaseHost(supabase));
    return [];
  }
  const parsed = parseMaybeStringData(data);
  return Array.isArray(parsed) ? (parsed as { id: string; name: string }[]) : [];
}
