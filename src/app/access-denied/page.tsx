import { APP_NAME } from "@/lib/constants";
import { getMe } from "@/lib/auth";
import SignOutButton from "@/components/SignOutButton";

export const metadata = { title: "אין הרשאת גישה" };

const REASONS: Record<string, string> = {
  unauthorized:
    "אין רשות סגל התואמת לחשבון זה. פנו למנהל המערכת כדי להוסיף את כתובת האימייל לספר הצוות.",
  inactive: "החשבון קיים בספר הצוות אך מושבה. פנו למנהל המערכת להפעלה מחדש.",
  conflict:
    "זהות הצוות כבר מקושרת לחשבון Google אחר. פנו למנהל המערכת — האירוע תועד.",
  email_unverified:
    "כתובת האימייל של חשבון Google אינה מאומתת. אמתו את הכתובת ב-Google ונסו שוב.",
  error: "אירעה שגיאה בקישור הזהות. נסו להתחבר שוב.",
};

export default async function AccessDeniedPage({
  searchParams,
}: PageProps<"/access-denied">) {
  const sp = await searchParams;
  const me = await getMe().catch(() => null);
  const email = me?.email ?? null;
  const reason =
    typeof sp.reason === "string" ? REASONS[sp.reason] ?? REASONS["error"] : null;

  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6 text-center">
      <div className="max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.png"
          alt={APP_NAME}
          className="w-20 h-20 object-contain opacity-80"
        />
        <h1 className="text-2xl font-extrabold">אין הרשאת גישה</h1>
        <p className="text-muted leading-7">
          {email ? (
            <>
              החשבון <span dir="ltr" className="font-medium">{email}</span> מחובר,
              אך הוא אינו מוגדר כאיש צוות פעיל של תיכון החממה.
            </>
          ) : (
            "החשבון המחובר אינו מוגדר כאיש צוות פעיל של תיכון החממה."
          )}
          {reason && <span className="block mt-2">{reason}</span>}
        </p>
        <SignOutButton />
      </div>
    </main>
  );
}
