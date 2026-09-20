"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  type FormSchema, type FormField, type FormStep, type FieldType,
  validateFormAnswers, detectBranchCycles,
} from "@/lib/form-schema";
import { formSaveDraftAction, formPublishAction, formArchiveAction, formDeleteDraftAction } from "@/lib/actions/forms";

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "short_text", label: "טקסט קצר" },
  { value: "long_text", label: "טקסט ארוך" },
  { value: "single_choice", label: "בחירה יחידה" },
  { value: "multiple_choice", label: "בחירה מרובה" },
  { value: "yes_no", label: "כן/לא" },
  { value: "number", label: "מספר" },
  { value: "scale", label: "סקאלה 1–5" },
  { value: "gyr", label: "ירוק/צהוב/אדום" },
  { value: "date", label: "תאריך" },
  { value: "heading", label: "כותרת / טקסט מידע" },
  { value: "acknowledgement", label: "אישור" },
];

export default function FormBuilder({ definition }: {
  definition: {
    id: string; form_key: string; name: string; description: string | null;
    audience: string; feed_category: string; status: string;
    draft_schema: FormSchema | null; current_version_id: string | null;
  };
}) {
  const router = useRouter();
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description ?? "");
  const [schema, setSchema] = useState<FormSchema>(
    definition.draft_schema ?? { version: "1", steps: [{ id: "s1", title: "שאלות" }], fields: [] }
  );
  const [selectedFieldIdx, setSelectedFieldIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const keyCounter = useRef(0);

  const activeField = selectedFieldIdx !== null ? schema.fields[selectedFieldIdx] : null;

  function updateSchema(next: FormSchema) { setSchema(next); }
  function updateField(idx: number, patch: Partial<FormField>) {
    const fields = [...schema.fields];
    fields[idx] = { ...fields[idx], ...patch };
    updateSchema({ ...schema, fields });
  }
  function addField(type: FieldType) {
    keyCounter.current += 1;
    const key = `f_${keyCounter.current}`;
    const stepId = schema.steps[0]?.id ?? "s1";
    updateSchema({
      ...schema,
      fields: [...schema.fields, { key, type, label: `שדה חדש`, required: false, stepId }],
    });
    setSelectedFieldIdx(schema.fields.length);
  }
  function deleteField(idx: number) {
    const fields = schema.fields.filter((_, i) => i !== idx);
    updateSchema({ ...schema, fields });
    setSelectedFieldIdx(null);
  }
  function duplicateField(idx: number) {
    const src = schema.fields[idx];
    keyCounter.current += 1;
    const copy = { ...src, key: `${src.key}_copy_${keyCounter.current}` };
    const fields = [...schema.fields];
    fields.splice(idx + 1, 0, copy);
    updateSchema({ ...schema, fields });
  }
  function reorderField(from: number, to: number) {
    const fields = [...schema.fields];
    const [moved] = fields.splice(from, 1);
    fields.splice(to, 0, moved);
    updateSchema({ ...schema, fields });
    setSelectedFieldIdx(to);
  }

  function save() {
    setError(null);
    const fd = new FormData();
    fd.set("formId", definition.id);
    fd.set("name", name);
    fd.set("description", description);
    fd.set("feedCategory", definition.feed_category);
    fd.set("schema", JSON.stringify(schema));
    startTransition(async () => {
      const res = await formSaveDraftAction(null, fd);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  function publish() {
    setError(null);
    const cycles = detectBranchCycles(schema);
    if (cycles.length > 0) { setError(cycles[0]); return; }
    const fd = new FormData();
    fd.set("formId", definition.id);
    fd.set("name", name);
    fd.set("description", description);
    fd.set("feedCategory", definition.feed_category);
    fd.set("schema", JSON.stringify(schema));
    startTransition(async () => {
      const saveRes = await formSaveDraftAction(null, fd);
      if (!saveRes.ok) { setError(saveRes.error); return; }
      const pubFd = new FormData();
      pubFd.set("formId", definition.id);
      const pubRes = await formPublishAction(null, pubFd);
      if (!pubRes.ok) { setError(pubRes.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* basic info */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <label className="block text-sm font-semibold">שם הטופס
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
        </label>
        <label className="mt-2 block text-sm font-semibold">תיאור
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
        </label>
        <p dir="ltr" className="mt-1 text-xs text-muted">{definition.form_key} · {definition.audience} · {definition.feed_category}</p>
      </section>

      {/* fields list with drag reorder */}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h3 className="font-extrabold">שדות ({schema.fields.length})</h3>
        <p className="mt-1 text-xs text-muted">גררו כדי לסדר מחדש. לחצו כדי לערוך.</p>
        <ul className="mt-2 flex flex-col gap-1">
          {schema.fields.map((f, idx) => (
            <li
              key={f.key}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", String(idx))}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = Number(e.dataTransfer.getData("text/plain"));
                if (from !== idx) reorderField(from, idx);
              }}
              className={`flex cursor-grab items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${selectedFieldIdx === idx ? "border-brand-dark bg-brand-soft" : "border-line bg-bg"}`}
              onClick={() => setSelectedFieldIdx(idx)}
            >
              <span className="truncate font-semibold">{f.label}</span>
              <span className="text-xs text-muted">{f.type}</span>
              <span className="flex gap-1">
                <button type="button" onClick={(e) => { e.stopPropagation(); duplicateField(idx); }} className="text-xs text-muted hover:text-ink" aria-label="שכפול">⧉</button>
                <button type="button" onClick={(e) => { e.stopPropagation(); deleteField(idx); }} className="text-xs text-danger hover:text-danger" aria-label="מחיקה">✕</button>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap gap-1">
          {FIELD_TYPES.map((t) => (
            <button key={t.value} type="button" onClick={() => addField(t.value)}
              className="rounded-full border border-line bg-bg px-2.5 py-1 text-xs font-semibold hover:bg-brand-soft">
              + {t.label}
            </button>
          ))}
        </div>
      </section>

      {/* field editor */}
      {activeField && (
        <section className="rounded-2xl border border-brand-dark bg-surface p-4">
          <h3 className="font-extrabold">עריכת שדה: {activeField.label}</h3>
          <label className="mt-2 block text-sm">תווית
            <input value={activeField.label} onChange={(e) => updateField(selectedFieldIdx!, { label: e.target.value })} className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
          <label className="mt-2 block text-sm">טקסט עזרה
            <input value={activeField.help ?? ""} onChange={(e) => updateField(selectedFieldIdx!, { help: e.target.value })} className="mt-1 w-full rounded-xl border border-line px-3 py-2" />
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={activeField.required ?? false} onChange={(e) => updateField(selectedFieldIdx!, { required: e.target.checked })} className="h-5 w-5 accent-[#46b800]" />
            שדה חובה
          </label>
          {(activeField.type === "single_choice" || activeField.type === "multiple_choice") && (
            <div className="mt-2">
              <p className="text-sm font-semibold">אפשרויות</p>
              {(activeField.options ?? []).map((o, oi) => (
                <div key={oi} className="mt-1 flex gap-2">
                  <input value={o.value} disabled dir="ltr" className="w-24 rounded-lg border border-line px-2 py-1 text-xs" />
                  <input value={o.label} onChange={(e) => {
                    const opts = [...(activeField.options ?? [])];
                    opts[oi] = { ...o, label: e.target.value };
                    updateField(selectedFieldIdx!, { options: opts });
                  }} className="flex-1 rounded-lg border border-line px-2 py-1 text-xs" />
                </div>
              ))}
              <button type="button" onClick={() => updateField(selectedFieldIdx!, {
                options: [...(activeField.options ?? []), { value: `opt_${(activeField.options?.length ?? 0) + 1}`, label: `אפשרות ${(activeField.options?.length ?? 0) + 1}` }],
              })} className="mt-1 text-xs font-bold text-brand-dark">+ אפשרות</button>
            </div>
          )}
          {activeField.branch && (
            <div className="mt-2 rounded-xl bg-bg p-2 text-xs">
              <p className="font-bold">הסתעפות</p>
              <p>כאשר תשובה ל-{activeField.branch.when.field} {activeField.branch.when.op} {activeField.branch.when.value} → עבור ל-{activeField.branch.gotoStep}</p>
            </div>
          )}
        </section>
      )}

      {error && <p role="alert" className="text-sm font-bold text-danger">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={pending} className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60">שמירת טיוטה</button>
        <button type="button" onClick={publish} disabled={pending} className="rounded-full bg-brand px-5 py-2.5 text-sm font-extrabold text-ink disabled:opacity-60">פרסום</button>
        {definition.status === "published" && (
          <Link href={`/forms/staff/${definition.form_key}`} className="rounded-full border border-line px-4 py-2.5 text-sm font-bold">תצוגה מקדימה</Link>
        )}
        {definition.status === "draft" && (
          <button type="button" onClick={() => {
            const fd = new FormData(); fd.set("formId", definition.id);
            startTransition(async () => { await formDeleteDraftAction(null, fd); router.push("/admin/forms"); });
          }} className="rounded-full border border-line px-4 py-2.5 text-sm font-bold text-danger">מחיקת טיוטה</button>
        )}
      </div>
    </div>
  );
}
