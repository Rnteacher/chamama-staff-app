/**
 * TypeScript mirror of the database permission model.
 *
 * THE DATABASE IS THE SOURCE OF TRUTH (see supabase/migrations/
 * 20260915000002_security.sql → can_user_read_message). This mirror exists
 * only so the UI can decide which controls to render and so the permission
 * matrix is covered by fast unit tests. It must never be used as the sole
 * authorization mechanism — every query and mutation is additionally
 * enforced by RLS on the server.
 */

export type Role =
  | "staff"
  | "mentor"
  | "master"
  | "major_head"
  | "counselor"
  | "project_coordinator"
  | "employment_coordinator"
  | "leadership"
  | "super_admin";

export const ALL_ROLES: Role[] = [
  "staff",
  "mentor",
  "master",
  "major_head",
  "counselor",
  "project_coordinator",
  "employment_coordinator",
  "leadership",
  "super_admin",
];

/**
 * Roles an administrator can manually assign. The implicit base "staff"
 * identity is NOT selectable — being present in the staff directory already
 * means the person is staff; mentor/master/major-head are additionally
 * derived from the canonical relationship tables (group_mentors,
 * master_assignments, major_heads), not from this list.
 */
export const SELECTABLE_ROLES: Role[] = ALL_ROLES.filter((r) => r !== "staff");

export const PRIVILEGED_ROLES: readonly Role[] = [
  "counselor",
  "project_coordinator",
  "leadership",
] as const;

/**
 * Roles that genuinely own at least ONE management area (canonical mirror of
 * the /admin shell guard): super_admin (everything), project_coordinator
 * (הצהרת כוונות), employment_coordinator / leadership (תעסוקה).
 * "staff" is NOT a management capability — being on staff grants nothing.
 * Each management sub-route keeps enforcing its own narrower authorization.
 */
export const MANAGEMENT_ROLES: readonly Role[] = [
  "super_admin",
  "project_coordinator",
  "employment_coordinator",
  "leadership",
];

export function canAccessManagement(roles: readonly Role[]): boolean {
  return roles.some((r) => (MANAGEMENT_ROLES as readonly string[]).includes(r));
}

export interface PermissionContext {
  roles: Role[];
  /** student ids belonging to groups this user mentors */
  mentoredStudentIds: ReadonlySet<string>;
  /** student ids assigned to this user as master */
  masteredStudentIds: ReadonlySet<string>;
  /** student ids in majors headed by this user */
  majorHeadStudentIds: ReadonlySet<string>;
}

export interface MessageLike {
  studentId: string;
  isGeneralVisible: boolean;
  isHiddenFromLeads: boolean;
}

export function isPrivileged(ctx: Pick<PermissionContext, "roles">): boolean {
  return ctx.roles.some((r) => (PRIVILEGED_ROLES as readonly string[]).includes(r));
}

export function isStudentMentor(
  ctx: Pick<PermissionContext, "mentoredStudentIds">,
  studentId: string
): boolean {
  return ctx.mentoredStudentIds.has(studentId);
}

export function isAssignedMaster(
  ctx: Pick<PermissionContext, "masteredStudentIds">,
  studentId: string
): boolean {
  return ctx.masteredStudentIds.has(studentId);
}

export function isMajorHeadForStudent(
  ctx: Pick<PermissionContext, "majorHeadStudentIds">,
  studentId: string
): boolean {
  return ctx.majorHeadStudentIds.has(studentId);
}

/**
 * Deterministic read precedence (mirrors can_user_read_message):
 * 1. counselor / project_coordinator / leadership → everything
 * 2. student's mentor → everything about their group
 * 3. hidden from leads → masters + major heads (and everyone else except
 *    the two above) denied, even if generally visible
 * 4. assigned master → may read
 * 5. relevant major head → may read
 * 6. approved for general visibility → any authorized staff
 * 7. otherwise deny
 *
 * Note: authorship alone never grants read access (explicit product rule).
 */
export function canReadMessage(
  ctx: PermissionContext,
  msg: MessageLike
): boolean {
  if (isPrivileged(ctx)) return true;
  if (isStudentMentor(ctx, msg.studentId)) return true;
  if (msg.isHiddenFromLeads) return false;
  if (isAssignedMaster(ctx, msg.studentId)) return true;
  if (isMajorHeadForStudent(ctx, msg.studentId)) return true;
  return msg.isGeneralVisible;
}

/** Only a mentor of the student's group may moderate that message. */
export function canModerateMessage(
  ctx: Pick<PermissionContext, "mentoredStudentIds">,
  studentId: string
): boolean {
  return isStudentMentor(ctx, studentId);
}
