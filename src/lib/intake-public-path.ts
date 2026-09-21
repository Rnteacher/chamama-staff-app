/**
 * THE canonical builder for the public intake link.
 * Used by: intake creation, "יצירת קישור נוסף" and "העתקת קישור" — so the
 * flows can never diverge. The origin is supplied by the CALLER (the browser
 * passes window.location.origin), which guarantees the copied URL always
 * matches the current environment: production copies the production domain,
 * previews copy the preview domain, local copies localhost.
 */
export const INTAKE_PUBLIC_ROUTE = "/intake";

export function buildIntakePublicUrl(token: string, origin: string): string {
  return new URL(
    `${INTAKE_PUBLIC_ROUTE}/${encodeURIComponent(token)}`,
    origin
  ).toString();
}
