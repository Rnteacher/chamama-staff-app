import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-dvh bg-bg flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-2xl font-extrabold">הדף לא נמצא</h1>
      <p className="mt-2 text-muted">ייתכן שהכתובת שגויה או שהתוכן הוסר.</p>
      <Link
        href="/"
        className="mt-6 rounded-full bg-brand text-ink font-bold px-8 py-3"
      >
        חזרה לדף הבית
      </Link>
    </main>
  );
}
