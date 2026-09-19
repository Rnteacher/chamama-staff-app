import { requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { setIncludeNameInPushAction } from "@/lib/actions/admin";
import AdminActionForm from "@/components/admin/AdminActionForm";
import { hasVapidConfig } from "@/lib/server-env";

export const metadata = { title: "ניהול · הגדרות" };

export default async function AdminSettingsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "include_student_name_in_push")
    .maybeSingle();

  const includeName = setting?.value === true;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-extrabold">התראות דחיפה</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          ברירת המחדל שומרת על פרטיות: ההתראה אינה כוללת את שם החניך/ה.
          ניתן לאפשר הצגת שם פרטי בלבד בהתראות.
        </p>
        <AdminActionForm action={setIncludeNameInPushAction} submitLabel="שמירה" className="mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="includeName"
              defaultChecked={includeName}
              className="h-5 w-5 accent-[#46b800]"
            />
            הצגת שם פרטי של החניך/ה בהתראות
          </label>
        </AdminActionForm>
        <p className="mt-3 text-sm">
          מפתחות VAPID:{" "}
          {hasVapidConfig() ? (
            <strong className="text-brand-dark">מוגדרים</strong>
          ) : (
            <strong className="text-warn">חסרים — התראות כבויות (npm run gen:vapid)</strong>
          )}
        </p>
      </section>
    </div>
  );
}
