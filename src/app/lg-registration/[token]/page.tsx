import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { APP_NAME } from "@/lib/constants";
import LearningGroupRegistrationWizard from "@/components/learning-groups/LearningGroupRegistrationWizard";
import type { PublicLgregGroup } from "@/lib/lgreg-public";

export const metadata: Metadata = {
  title: "הרשמה לקבוצות למידה",
  robots: { index: false, follow: false },
};

// token-specific public page: never cache a transient RPC failure
export const dynamic = "force-dynamic";

interface LgregOverviewData {
  status: string;
  title?: string;
  opens_at?: string;
  closes_at?: string;
  home_groups?: { id: string; name: string }[];
  learning_groups?: PublicLgregGroup[];
}

/**
 * Public learning-group registration (no login) — token-gated anon RPCs only.
 */
export default async function LgregPage({
  params,
}: PageProps<"/lg-registration/[token]">) {
  const { token } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("public_lgreg_overview", {
    p_token: token,
  });
  const raw = (error ? null : data) as LgregOverviewData | null;
  // A failed RPC or unknown status is a TECHNICAL error state — never "invalid link".
  const status =
    raw &&
    (raw.status === "open" ||
      raw.status === "not_open" ||
      raw.status === "closed" ||
      raw.status === "invalid")
      ? raw.status
      : "error";

  let body: React.ReactNode;

  if (status === "open" && raw) {
    body = (
      <LearningGroupRegistrationWizard
        token={token}
        title={raw.title ?? "הרשמה לקבוצות למידה"}
        homeGroups={raw.home_groups ?? []}
        learningGroups={raw.learning_groups ?? []}
      />
    );
  } else if (status === "not_open") {
    body = (
      <StateCard
        title="ההרשמה עדיין לא נפתחה"
        text="חזרו לכאן כשההרשמה תיפתח. נתראה בקרוב!"
      />
    );
  } else if (status === "closed") {
    body = (
      <StateCard
        title="תקופת ההרשמה הסתיימה"
        text="ההרשמה לקבוצות הלמידה נסגרה. תודה על ההשתתפות."
      />
    );
  } else if (status === "error") {
    body = (
      <StateCard
        title="אירעה שגיאה טכנית"
        text="לא הצלחנו לטעון את הטופס כרגע. נסו לרענן את העמוד בעוד רגע, ואם הבעיה נמשכת פנו להנהלה."
      />
    );
  } else {
    // invalid or revoked token: fail closed, reveal nothing
    body = (
      <StateCard
        title="הקישור אינו תקין"
        text="ייתכן שהקישור שהתקבל אינו נכון או שהוא כבר לא בתוקף. פנו להנהלה לקישור עדכני."
      />
    );
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
