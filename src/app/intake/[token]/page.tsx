import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { APP_NAME } from "@/lib/constants";
import IntakeWizard from "@/components/intake/IntakeWizard";

export const metadata: Metadata = {
  title: "הצהרת כוונות לפרויקט",
  robots: { index: false, follow: false },
};

export default async function IntakePage({
  params,
}: PageProps<"/intake/[token]">) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_intake_overview", { p_token: token });
  const overview = (data ?? {}) as {
    status: "open" | "not_open" | "closed" | "invalid";
    title?: string;
    opens_at?: string;
    closes_at?: string;
    groups?: { id: string; name: string }[];
  };

  let body: React.ReactNode;

  if (overview.status === "open") {
    // pre-fetch majors + masters (minimal public fields, token-gated RPCs)
    const [majorsRes, mastersRes] = await Promise.all([
      supabase.rpc("public_intake_majors", { p_token: token }),
      supabase.rpc("public_intake_masters", { p_token: token }),
    ]);
    body = (
      <IntakeWizard
        token={token}
        title={overview.title ?? "הצהרת כוונות לפרויקט"}
        groups={overview.groups ?? []}
        majors={(majorsRes.data ?? []) as { id: string; name: string }[]}
        masters={(mastersRes.data ?? []) as { id: string; name: string }[]}
      />
    );
  } else if (overview.status === "not_open") {
    body = <StateCard title="הטופס עדיין לא נפתח" text="חזרו לכאן כשהטופס ייפתח. נתראה בקרוב!" />;
  } else if (overview.status === "closed") {
    body = <StateCard title="הטופס נסגר" text="תקופת ההצהרות הסתיימה. תודה על ההשתתפות." />;
  } else {
    // invalid or revoked token: fail closed, reveal nothing
    body = <StateCard title="הקישור אינו תקין" text="ייתכן שהקישור שהתקבל אינו נכון או שהוא כבר לא בתוקף. פנו לרכז/ת הפרויקטים לקישור עדכני." />;
  }

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt={APP_NAME} className="h-16 w-16 object-contain" />
        {body}
        <p className="text-xs text-muted">מערכת הצוות של {APP_NAME}</p>
      </div>
    </main>
  );
}

function StateCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="w-full rounded-3xl border border-line bg-surface p-8 text-center">
      <h1 className="text-xl font-extrabold">{title}</h1>
      <p className="mt-2 leading-7 text-muted">{text}</p>
    </div>
  );
}
