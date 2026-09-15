import { Heebo } from "next/font/google";
import { APP_NAME } from "@/lib/constants";
import LoginForm from "@/components/LoginForm";
import { hasSupabaseConfig } from "@/lib/env";

const heebo = Heebo({ subsets: ["hebrew", "latin"], display: "swap" });

export const metadata = { title: "התחברות" };

export default async function LoginPage({
  searchParams,
}: PageProps<"/login">) {
  const sp = await searchParams;
  const configured = hasSupabaseConfig();
  const oauthError = sp.error === "oauth";
  const exchangeError = sp.error === "exchange";
  const reason = typeof sp.reason === "string" ? sp.reason : null;

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
          <>
            {oauthError && (
              <div
                role="alert"
                className="w-full rounded-2xl border border-warn bg-amber-50 p-4 text-sm leading-6 text-right"
              >
                <p className="font-bold">ההתחברות עם Google נכשלה לפני השלמתה</p>
                <p className="mt-1 text-muted">
                  זהו כשל בשלב Google עצמו — ולא חוסר הרשאה למערכת. הגורמים
                  הנפוצים:
                </p>
                <ul className="mt-2 list-disc space-y-1 pr-5 text-muted">
                  <li>
                    Google חסמה את הבקשה (Access blocked) — ב-Google Cloud,
                    במסך ה-Consent, אם האפליקציה במצב Testing יש להוסיף את
                    כתובת המייל שלכם כ-Test user.
                  </li>
                  <li>
                    redirect_uri_mismatch — יש לוודא שהכתובת
                    <span dir="ltr">
                      {" "}
                      https://&lt;PROJECT_REF&gt;.supabase.co/auth/v1/callback{" "}
                    </span>
                    רשומה ב-Authorized redirect URIs של לקוח ה-OAuth.
                  </li>
                </ul>
                {reason && (
                  <p
                    dir="ltr"
                    className="mt-2 break-all rounded-lg bg-white/70 p-2 text-xs text-muted"
                  >
                    {reason}
                  </p>
                )}
              </div>
            )}
            {exchangeError && (
              <div
                role="alert"
                className="w-full rounded-2xl border border-warn bg-amber-50 p-4 text-sm leading-6 text-right"
              >
                <p className="font-bold">אימות הכניסה נכשל</p>
                <p className="mt-1 text-muted">
                  נסו שוב. אם הבעיה חוזרת, נקו את ה-cookies של האתר ונסו
                  שנית (ייתכן שנותרה התחברות חלקית מניסיון קודם).
                </p>
              </div>
            )}
            <LoginForm />
          </>
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
