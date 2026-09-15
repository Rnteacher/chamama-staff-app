import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape check only — referential integrity belongs to the database. */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export const uuidSchema = z.string().regex(UUID_RE, "מזהה לא תקין");

export const sendMessageSchema = z.object({
  studentId: uuidSchema,
  body: z
    .string()
    .trim()
    .min(1, "אפשר לשלוח רק הודעה לא ריקה")
    .max(5000, "ההודעה ארוכה מדי (עד 5000 תווים)"),
  isGeneralVisible: z.boolean().default(false),
  isHiddenFromLeads: z.boolean().default(false),
});

export const moderateMessageSchema = z.object({
  messageId: uuidSchema,
  isGeneralVisible: z.boolean(),
  isHiddenFromLeads: z.boolean(),
});

export const editMessageSchema = z.object({
  messageId: uuidSchema,
  body: z.string().trim().min(1, "אפשר לשמור רק הודעה לא ריקה").max(5000),
});

export const markMessagesReadSchema = z.object({
  messageIds: z.array(uuidSchema).max(500),
});

export const subscribePushSchema = z.object({
  endpoint: z.string().url("כתובת מנוי לא תקינה"),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  userAgent: z.string().max(300).optional(),
});

export const unsubscribePushSchema = z.object({
  endpoint: z.string().url(),
});

// ---------------------------------------------------------------- admin ----

export const staffEmailSchema = z.object({
  id: uuidSchema.optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("כתובת אימייל לא תקינה")),
  fullName: z.string().trim().max(120).optional().or(z.literal("")),
  isActive: z.boolean(),
});

export const setRolesSchema = z.object({
  userId: uuidSchema,
  roles: z.array(z.enum([
    "staff",
    "mentor",
    "master",
    "major_head",
    "counselor",
    "project_coordinator",
    "leadership",
    "super_admin",
  ])),
});

export const studentSchema = z.object({
  id: uuidSchema.optional(),
  firstName: z.string().trim().min(1, "חסר שם פרטי").max(80),
  lastName: z.string().trim().min(1, "חסר שם משפחה").max(80),
  groupId: uuidSchema.nullable(),
  majorId: uuidSchema.nullable(),
  isArchived: z.boolean().default(false),
});

export const groupSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "חסר שם קבוצה").max(80),
});

export const majorSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "חסר שם מגמה").max(80),
});

export const assignmentSchema = z.object({
  studentId: uuidSchema,
  masterIds: z.array(uuidSchema).max(50),
});

export const groupMentorsSchema = z.object({
  groupId: uuidSchema,
  mentorIds: z.array(uuidSchema).max(50),
});

export const majorHeadsSchema = z.object({
  majorId: uuidSchema,
  headIds: z.array(uuidSchema).max(50),
});

export const settingSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.unknown(),
});

export const csvStudentRowSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  groupName: z.string().trim().min(1),
  majorName: z.string().trim().optional().default(""),
});

export const csvStaffRowSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  fullName: z.string().trim().optional().default(""),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type StudentInput = z.infer<typeof studentSchema>;
