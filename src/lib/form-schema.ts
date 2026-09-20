/**
 * Form Engine — client-side schema types, validation mirror, and
 * ConversationalForm question builder. Pure functions, testable.
 *
 * The DB is the source of truth for the schema (form_versions.schema_json).
 * This module mirrors validate_form_answers() and definitionToQuestions().
 */

export type FieldType =
  | "short_text" | "long_text" | "single_choice" | "multiple_choice"
  | "yes_no" | "number" | "scale" | "date" | "time" | "datetime"
  | "gyr" | "student_selector" | "group_selector" | "major_selector"
  | "staff_selector" | "heading" | "acknowledgement";

export interface FormOption { value: string; label: string }

export interface FormCondition { field: string; op: "eq" | "neq" | "contains"; value: string }

export interface FormField {
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  stepId?: string;
  options?: FormOption[];
  visibleWhen?: FormCondition;
  branch?: { when: FormCondition; gotoStep: string };
}

export interface FormStep { id: string; title: string }

export interface FormSchema {
  version: string;
  steps: FormStep[];
  fields: FormField[];
  systemBindings?: Record<string, string>;
}

export interface FormDefinitionRow {
  id: string;
  form_key: string;
  name: string;
  description: string | null;
  audience: string;
  feed_category: string;
  status: string;
  draft_schema: FormSchema | null;
  current_version_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  submission_count?: number;
}

export function evaluateCondition(cond: FormCondition, answers: Record<string, unknown>): boolean {
  const val = answers[cond.field];
  switch (cond.op) {
    case "eq": return val === cond.value;
    case "neq": return val !== cond.value;
    case "contains": return Array.isArray(val) && val.includes(cond.value);
    default: return false;
  }
}

export function isFieldVisible(field: FormField, answers: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true;
  return evaluateCondition(field.visibleWhen, answers);
}

/** Detect branch cycles in the step graph. Returns error strings. */
export function detectBranchCycles(schema: FormSchema): string[] {
  const errors: string[] = [];
  const edges = new Map<string, string>();
  for (const f of schema.fields) {
    if (f.branch && f.stepId) edges.set(f.stepId, f.branch.gotoStep);
  }
  for (const start of schema.steps.map((s) => s.id)) {
    const visited = new Set<string>();
    const stack = [start];
    let current = start;
    while (current && edges.has(current)) {
      if (visited.has(current)) { errors.push(`branching loop at step: ${start}`); break; }
      visited.add(current);
      current = edges.get(current)!;
      if (current === start) { errors.push(`branching loop at step: ${start}`); break; }
    }
  }
  return errors;
}

/** Authoritative schema validation (mirrors validate_form_answers in SQL). */
export function validateFormAnswers(
  schema: FormSchema,
  answers: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const field of schema.fields) {
    const val = answers[field.key];
    const required = field.required ?? false;
    const empty =
      val === undefined || val === null || val === "" ||
      (Array.isArray(val) && val.length === 0);
    if (required && empty) { errors.push(`missing required field: ${field.key}`); continue; }
    if (empty) continue;
    if (field.type === "single_choice" && typeof val === "string") {
      const opts = field.options?.map((o) => o.value) ?? [];
      if (!opts.includes(val)) errors.push(`field ${field.key} has invalid option`);
    }
    if (field.type === "multiple_choice" && Array.isArray(val)) {
      const opts = field.options?.map((o) => o.value) ?? [];
      for (const v of val) { if (!opts.includes(v as string)) errors.push(`field ${field.key} invalid option`); }
    }
    if (field.type === "yes_no" && typeof val === "string" && val !== "yes" && val !== "no") {
      errors.push(`field ${field.key} must be yes or no`);
    }
    if (field.type === "scale" && typeof val === "number" && (val < 1 || val > 5)) {
      errors.push(`field ${field.key} must be 1-5`);
    }
  }
  const knownKeys = new Set(schema.fields.map((f) => f.key));
  for (const key of Object.keys(answers)) {
    if (!knownKeys.has(key)) errors.push(`unknown answer key: ${key}`);
  }
  return { valid: errors.length === 0, errors };
}

/** Build the CSV text for the project coordinator export. */
export function buildCsvExport(
  headers: string[],
  rows: string[][]
): string {
  const esc = (v: string) => {
    const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /["\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
}
