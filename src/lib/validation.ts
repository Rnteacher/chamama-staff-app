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

export const staffCreateSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("כתובת אימייל לא תקינה")),
  fullName: z.string().trim().max(120).optional().or(z.literal("")),
  isActive: z.boolean(),
  roles: z.array(
    z.enum([
      "staff",
      "mentor",
      "master",
      "major_head",
      "counselor",
      "project_coordinator",
      "employment_coordinator",
      "leadership",
      "super_admin",
    ])
  ),
});

export const staffUpdateSchema = z.object({
  id: uuidSchema,
  fullName: z.string().trim().max(120).optional().or(z.literal("")),
  isActive: z.boolean(),
});

export const setRolesSchema = z.object({
  staffId: uuidSchema,
  roles: z.array(z.enum([
    "staff",
    "mentor",
    "master",
    "major_head",
    "counselor",
    "project_coordinator",
    "employment_coordinator",
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
  schoolYear: z.coerce
    .number()
    .int()
    .min(1, "שכבה לא תקינה")
    .max(4, "שכבה לא תקינה")
    .nullable()
    .optional(),
  isArchived: z.boolean().default(false),
});

export const groupSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "חסר שם קבוצה").max(80),
});

// ------------------------------------------------------ learning groups ----

export const learningGroupSlotSchema = z
  .object({
    weekday: z
      .number()
      .int()
      .min(0, "יום בשבוע לא תקין")
      .max(6, "יום בשבוע לא תקין"),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "שעה לא תקינה (HH:MM)"),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "שעה לא תקינה (HH:MM)"),
  })
  .refine((s) => s.startTime < s.endTime, {
    message: "שעת הסיום חייבת להיות אחרי שעת ההתחלה",
  });

export const learningGroupSchema = z
  .object({
    id: uuidSchema.optional(),
    name: z.string().trim().min(1, "חסר שם קבוצה").max(120),
    description: z.string().trim().max(500).optional().or(z.literal("")),
    isActive: z.boolean().default(true),
    slots: z.array(learningGroupSlotSchema).min(1, "נדרש לפחות יום ושעת מפגש אחדים").max(30),
    staffLeaderIds: z.array(uuidSchema).max(50).default([]),
    studentLeaderIds: z.array(uuidSchema).max(50).default([]),
  })
  .refine(
    (v) => {
      const seen = new Set(
        v.slots.map((s) => `${s.weekday}|${s.startTime}|${s.endTime}`)
      );
      return seen.size === v.slots.length;
    },
    { message: "אותו מפגש הוגדר פעמיים" }
  );

export const learningGroupWindowSchema = z
  .object({
    title: z.string().trim().min(1, "חסרה כותרת").max(120),
    opensAt: z.string().min(1, "חסר זמן פתיחה"),
    closesAt: z.string().min(1, "חסר זמן סגירה"),
    learningGroupIds: z
      .array(uuidSchema)
      .min(1, "בחרו לפחות קבוצת למידה אחת להרשמה"),
  })
  .refine((v) => new Date(v.opensAt) < new Date(v.closesAt), {
    message: "שעת הפתיחה חייבת להיות לפני שעת הסגירה",
    path: ["closesAt"],
  });

// --------------------------------------------------------- calendar events --

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const calendarAudienceSchema = z
  .object({
    type: z.enum([
      "everyone",
      "staff_only",
      "home_group",
      "major",
      "learning_group",
      "staff_member",
    ]),
    greenhouseGroupId: uuidSchema.nullable().optional(),
    majorId: uuidSchema.nullable().optional(),
    learningGroupId: uuidSchema.nullable().optional(),
    staffId: uuidSchema.nullable().optional(),
  })
  .refine(
    (a) =>
      (a.type === "home_group" && !!a.greenhouseGroupId) ||
      (a.type === "major" && !!a.majorId) ||
      (a.type === "learning_group" && !!a.learningGroupId) ||
      (a.type === "staff_member" && !!a.staffId) ||
      a.type === "everyone" ||
      a.type === "staff_only",
    { message: "קהל יעד לא תקין" }
  );

export const calendarEventSchema = z
  .object({
    id: uuidSchema.optional(),
    title: z.string().trim().min(1, "חסרה כותרת").max(200),
    description: z.string().trim().max(2000).optional().or(z.literal("")),
    startDate: z.string().regex(DATE_RE, "תאריך התחלה לא תקין"),
    startTime: z.string(), // "HH:MM" or "" (all-day)
    endDate: z.string().regex(DATE_RE, "תאריך סיום לא תקין"),
    endTime: z.string(),
    isAllDay: z.boolean(),
    recurrence: z.enum(["none", "weekly", "monthly"]),
    recurrenceUntil: z
      .string()
      .regex(DATE_RE, "תאריך סיום חזרה לא תקין")
      .or(z.literal("")),
    audiences: z.array(calendarAudienceSchema).min(1, "נדרש לפחות קהל יעד אחד"),
  })
  .refine(
    (v) => {
      if (v.isAllDay) return true;
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(v.startTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.endTime);
    },
    { message: "שעות התחלה וסיום נדרשות" }
  )
  .refine(
    (v) =>
      v.endDate > v.startDate ||
      (v.endDate === v.startDate && (v.isAllDay || v.endTime > v.startTime)),
    { message: "סוף האירוע חייב להיות אחרי התחלתו" }
  )
  .refine(
    (v) =>
      v.recurrence === "none" ||
      (v.recurrenceUntil !== "" && v.recurrenceUntil >= v.startDate),
    { message: "אירוע חוזר דורש תאריך סיום מהתאריך הראשון ואילך" }
  );

export const majorSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "חסר שם מגמה").max(80),
});

export const assignmentSchema = z.object({
  studentId: uuidSchema,
  staffIds: z.array(uuidSchema).max(50),
});

export const groupMentorsSchema = z.object({
  groupId: uuidSchema,
  staffIds: z.array(uuidSchema).max(50),
});

export const majorHeadsSchema = z.object({
  majorId: uuidSchema,
  staffIds: z.array(uuidSchema).max(50),
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

// ------------------------------------------------------------ employment ----

export const employmentSlotSchema = learningGroupSlotSchema;

export const employmentPlacementSchema = z
  .object({
    studentId: uuidSchema,
    workplaceName: z.string().trim().min(1, "חסר שם מקום עבודה").max(120),
    contactName: z.string().trim().max(120).optional().or(z.literal("")),
    contactPhone: z.string().trim().max(30).optional().or(z.literal("")),
    startDate: z.string().regex(DATE_RE, "תאריך התחלה לא תקין"),
    endDate: z.string().regex(DATE_RE, "תאריך סיום לא תקין").or(z.literal("")),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
    slots: z.array(employmentSlotSchema).max(28),
  })
  .refine((v) => v.endDate === "" || v.endDate >= v.startDate, {
    message: "תאריך סיום חייב להיות מאוחר מתאריך ההתחלה",
    path: ["endDate"],
  });

export const employmentExceptionSchema = z
  .object({
    placementId: uuidSchema,
    workDate: z.string().regex(DATE_RE, "תאריך לא תקין"),
    kind: z.enum(["add", "cancel", "modify"]),
    startTime: z.string(),
    endTime: z.string(),
    note: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine(
    (v) =>
      v.kind === "cancel"
        ? v.startTime === "" && v.endTime === ""
        : /^([01]\d|2[0-3]):[0-5]\d$/.test(v.startTime) &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(v.endTime) &&
          v.endTime > v.startTime,
    { message: "שעות עבודה לא תקינות" }
  );

export const workLogSchema = z
  .object({
    placementId: uuidSchema,
    workDate: z.string().regex(DATE_RE, "תאריך עבודה לא תקין"),
    startTime: z.string(), // "HH:MM" or ""
    endTime: z.string(), // "HH:MM" or ""
    durationMinutes: z.coerce.number().int().min(0).max(720).optional(),
    note: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .refine(
    (v) =>
      v.startTime !== "" && v.endTime !== ""
        ? /^([01]\d|2[0-3]):[0-5]\d$/.test(v.startTime) &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(v.endTime)
        : (v.durationMinutes ?? 0) >= 1,
    { message: "הזינו שעות התחלה וסיום או משך עבודה" }
  )
  .refine(
    (v) =>
      v.startTime === "" ||
      v.endTime === "" ||
      /^([01]\d|2[0-3]):[0-5]\d$/.test(v.startTime),
    { message: "שעות לא תקינות — הזינו התחלה וסיום או משך בלבד" }
  );

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type StudentInput = z.infer<typeof studentSchema>;
