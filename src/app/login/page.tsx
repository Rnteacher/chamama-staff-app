import { Heebo } from "next/font/google";
import { APP_NAME } from "@/lib/constants";
import LoginForm from "@/components/LoginForm";
import { hasSupabaseConfig } from "@/lib/env";

const heebo = Heebo({ subsets: ["hebrew", "latin"], display: "swap" });

export const metadata = { title: "התחברות" };

export default function LoginPage() {
  const configured = hasSupabaseConfig();
  return (
    <div
      lang="he"
      dir="rtl"
      className={`${heebo.className} min-h-dvh bg-bg flex flex-col items-center justify-center p-6`}
    >
      <div className="w-full max-w-sm flex flex-col items-center gap-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt={`לוגו ${APP_NAME}`}
          className="w-28 h-28 object-contain"
        />
        <div>
          <h1 className="text-2xl font-extrabold text-ink">{APP_NAME}</h1>
          <p className="mt-1 text-muted">מערכת עדכונים לצוות</p>
        </div>

        {configured ? (
          <LoginForm />
        ) : (
          <div
            role="alert"
            className="w-full rounded-2xl border border-line bg-surface p-4 text-sm text-muted"
          >
            המערכת עוד לא הוגדרה: חסרים משתני הסביבה של Supabase.
            <br />
            עיינו ב-README ובקובץ ‎.env.example
          </div>
        )}

        <p className="text-xs leading-5 text-muted max-w-xs">
          הכניסה מיועדת לצוות בית הספר בלבד. חשבון Google שאינו רשום
          במאגר אנשי הצוות לא יוכל לצפות בתכנים.
        </p>
      </div>
    </div>
  );
}
