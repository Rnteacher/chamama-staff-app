import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { APP_NAME } from "@/lib/constants";
import type { FormSchema } from "@/lib/form-schema";
import PublicFormWizard from "@/components/forms/PublicFormWizard";

export const metadata: Metadata = { title: "טופס", robots: { index: false, follow: false } };

export default async function PublicFormPage({
  params,
}: PageProps<"/forms/[token]">) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_form_overview", { p_token: token });
  const overview = (data ?? {}) as {
    status: "open" | "not_open" | "closed" | "invalid" | "error";
    form_name?: string;
    description?: string;
    schema?: FormSchema;
    subject_student?: { id: string; first_name: string } | null;
  };

  let body: React.ReactNode;

  if (overview.status === "open" && overview.schema) {
    body = (
      <div className="w-full">
        <div className="mb-5 text-center">
          <h1 className="mt-1 text-xl font-extrabold">{overview.form_name}</h1>
          {overview.subject_student && (
            <p className="mt-1 text-sm text-muted">
              שלום {overview.subject_student.first_name}!
            </p>
          )}
        </div>
        <PublicFormWizard token={token} schema={overview.schema}
          subjectName={overview.subject_student?.first_name ?? null} />
      </div>
    );
  } else if (overview.status === "not_open") {
    body = <Card title="הטופס עדיין לא נפתח" text="חזרו לכאן כשהטופס ייפתח." />;
  } else if (overview.status === "closed") {
    body = <Card title="הטופס נסגר" text="תקופת המילוי הסתיימה." />;
  } else if (overview.status === "error") {
    body = <Card title="אירעה שגיאה טכנית" text="נסו לרענן בעוד רגע." />;
  } else {
    body = <Card title="הקישור אינו תקין" text="פנו לרכז/ת לקישור עדכני." />;
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg flex flex-col items-center gap-6">
        <img src="/logo.png" alt={APP_NAME} className="h-16 w-16 object-contain" />
        {body}
        <p className="text-xs text-muted">{APP_NAME}</p>
      </div>
    </main>
  );
}

function Card({ title, text }: { title: string; text: string }) {
  return (
    <div className="w-full rounded-3xl border border-line bg-surface p-8 text-center">
      <h1 className="text-xl font-extrabold">{title}</h1>
      <p className="mt-2 leading-7 text-muted">{text}</p>
    </div>
  );
}
