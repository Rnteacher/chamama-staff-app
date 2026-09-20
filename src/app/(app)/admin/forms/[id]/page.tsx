import Link from "next/link";
import FormBuilder from "@/components/forms/FormBuilder";
import { requireMe, hasRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = { title: "בונה טפסים" };

export default async function FormBuilderPage({
  params,
}: PageProps<"/admin/forms/[id]">) {
  const me = await requireMe();
  if (!hasRole(me, "super_admin") && !hasRole(me, "project_coordinator")) {
    redirect("/");
  }
  const { id } = await params;
  const supabase = await createClient();
  const { data: def } = await supabase
    .from("form_definitions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!def) redirect("/admin/forms");

  return (
    <div className="flex flex-col gap-4">
      <Link href="/admin/forms" className="text-sm font-medium text-muted hover:text-ink">‹ חזרה לטפסים</Link>
      <FormBuilder definition={def} />
    </div>
  );
}
