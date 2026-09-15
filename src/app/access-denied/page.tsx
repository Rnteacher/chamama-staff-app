import { APP_NAME } from "@/lib/constants";
import { getMe } from "@/lib/auth";
import SignOutButton from "@/components/SignOutButton";

export const metadata = { title: "אין הרשאת גישה" };

export default async function AccessDeniedPage() {
  const me = await getMe().catch(() => null);
  const email = me?.email ?? null;
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
          <br />
          לקבלת גישה, פנו למנהל המערכת על מנת להוסיף את כתובת האימייל
          לרשימת אנשי הצוות המורשים.
        </p>
        <SignOutButton />
      </div>
    </main>
  );
}
