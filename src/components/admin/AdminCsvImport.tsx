"use client";

import { useRef, useState } from "react";
import AdminActionForm, { type AdminAction } from "@/components/admin/AdminActionForm";

export default function AdminCsvImport({ action }: { action: AdminAction }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file, "utf-8");
  }

  return (
    <AdminActionForm action={action} submitLabel="ייבוא" className="mt-3">
      <input type="hidden" name="csv" value={text} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="block">בחירת קובץ CSV</span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="mt-1 block w-full text-sm"
          />
        </label>
        {fileName && <span className="text-sm text-muted">{fileName}</span>}
      </div>
      {text && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">תצוגה מקדימה</summary>
          <pre dir="ltr" className="mt-1 max-h-40 overflow-auto rounded-xl bg-bg p-2 text-xs">
            {text.slice(0, 1000)}
          </pre>
        </details>
      )}
    </AdminActionForm>
  );
}
