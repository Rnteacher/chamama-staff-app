/**
 * THE canonical builder for the public learning-group registration link.
 * Used by window creation and Copy-Link so the flows can never diverge.
 * The origin is supplied by the CALLER (the browser passes
 * window.location.origin), so the copied URL always matches the current
 * environment (production/preview/local).
 */
export const LREG_PUBLIC_ROUTE = "/lg-registration";

export function buildLgregPublicUrl(token: string, origin: string): string {
  return new URL(
    `${LREG_PUBLIC_ROUTE}/${encodeURIComponent(token)}`,
    origin
  ).toString();
}
