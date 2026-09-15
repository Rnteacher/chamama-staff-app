import type { Role } from "@/lib/permissions";

export const ROLE_LABELS: Record<Role, string> = {
  staff: "צוות",
  mentor: "מנטור",
  master: "מאסטר",
  major_head: "ראש מגמה",
  counselor: "יועצ/ת",
  project_coordinator: "רכז/ת פרויקטים",
  leadership: "הנהלה",
  super_admin: "מנהל מערכת",
};

export const APP_NAME = "תיכון החממה";
export const APP_SHORT_NAME = "חממה";
