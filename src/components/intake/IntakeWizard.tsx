"use client";

import { useCallback, useEffect, useState } from "react";
import ConversationalForm, {
  type Question,
  type Answers,
} from "@/components/conversational/ConversationalForm";
import { createBrowserClient } from "@/lib/supabase/browser";

export interface IntakeWizardProps {
  token: string;
  title: string;
  groups: { id: string; name: string }[];
  majors: { id: string; name: string }[];
  masters: { id: string; name: string }[];
}

/**
 * Public student intake wizard (no login). Data comes only from the
 * token-gated anon RPCs; the server revalidates everything on submit.
 */
export default function IntakeWizard({
  token,
  title,
  groups,
  majors,
  masters,
}: IntakeWizardProps) {
  const [answers, setAnswers] = useState<Answers>({});
  const [students, setStudents] = useState<{ id: string; first_name: string; last_name: string }[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const groupId = typeof answers.group_id === "string" ? answers.group_id : null;

  const loadStudents = useCallback(async (gid: string) => {
    await Promise.resolve(); // keep setState out of the synchronous effect body
    setLoadingStudents(true);
    try {
      const supabase = createBrowserClient();
      const { data } = await supabase.rpc("public_intake_students", {
        p_token: token,
        p_group_id: gid,
      });
      setStudents((data ?? []) as { id: string; first_name: string; last_name: string }[]);
    } finally {
      setLoadingStudents(false);
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (groupId && !cancelled) void loadStudents(groupId);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, loadStudents]);

  const onAnswersChange = useCallback(
    (next: Answers) => {
      if (next.group_id !== answers.group_id) {
        // changing the group invalidates the name choice
        next = { ...next, student_id: undefined };
        setStudents([]);
      }
      setAnswers(next);
    },
    [answers.group_id]
  );

  const questions: Question[] = [
    {
      id: "group_id",
      title: "באיזו קבוצה אתם?",
      type: "single-select",
      options: groups.map((g) => ({ value: g.id, label: g.name })),
    },
    {
      id: "student_id",
      title: "מי אתם?",
      subtitle: loadingStudents ? "טוען חניכים…" : "בחרו את שמכם מהרשימה",
      type: "single-select",
      options: students.map((s) => ({
        value: s.id,
        label: `${s.first_name} ${s.last_name}`,
      })),
      validate: (a) => {
        const sid = a.student_id;
        if (typeof sid !== "string" || !students.some((s) => s.id === sid)) {
          return "בחרו את שמכם מהרשימה";
        }
        return null;
      },
    },
    {
      id: "intent",
      title: "מה הכוונה הראשונית שלכם לפרויקט?",
      subtitle: "כתבו משפט אחד קצר",
      type: "textarea",
      maxLength: 500,
      placeholder: "למשל: אני רוצה לבנות אפליקציה שעוזרת לתלמידים לארגן את שעות הלימודים…",
      validate: (a) =>
        typeof a.intent === "string" && a.intent.trim().length > 0
          ? null
          : "כתבו משפט אחד",
    },
    {
      id: "major_choice",
      title: "האם הפרויקט שייך למגמה?",
      type: "single-select",
      options: [
        { value: "none", label: "לא במגמה" },
        ...majors.map((m) => ({ value: m.id, label: m.name })),
      ],
    },
    {
      id: "master_id",
      title: "איזה מאסטר/ית תרצו שילווה אתכם?",
      subtitle: "זו הצעה בלבד — השיבוץ הסופי נקבע על ידי רכז/ת הפרויקטים",
      type: "single-select",
      options: masters.map((m) => ({ value: m.id, label: m.name })),
    },
  ];

  async function submit() {
    setSubmitError(null);
    const supabase = createBrowserClient();
    const majorChoice = answers.major_choice;
    const { data, error } = await supabase.rpc("public_intake_submit", {
      p_token: token,
      p_student_id: String(answers.student_id ?? ""),
      p_group_id: String(answers.group_id ?? ""),
      p_intent: String(answers.intent ?? ""),
      p_major_id: majorChoice && majorChoice !== "none" ? String(majorChoice) : null,
      p_master_staff_id: String(answers.master_id ?? ""),
    });
    if (error) {
      setSubmitError("השליחה נכשלה. בדקו את החיבור ונסו שוב.");
      throw error;
    }
    const res = (data ?? {}) as { status?: string; message?: string };
    if (res.status !== "ok") {
      setSubmitError(
        res.status === "closed"
          ? "הטופס נסגר בינתיים. פנו לרכז/ת הפרויקטים."
          : res.status === "not_open"
            ? "הטופס נסגר זה עתה. נסו שוב מוקדם יותר בפעם הבאה."
            : res.status === "invalid"
              ? "הקישור אינו תקין. פנו לרכז/ת הפרויקטים."
              : res.message ?? "השליחה נכשלה. נסו שוב."
      );
      throw new Error(res.status ?? "error");
    }
  }

  return (
    <div className="w-full max-w-lg">
      <div className="mb-5 text-center">
        <p className="text-sm font-semibold text-muted">הצהרת כוונות ראשונית לפרויקט</p>
        <h1 className="mt-1 text-xl font-extrabold">{title}</h1>
      </div>
      <ConversationalForm
        questions={questions}
        answers={answers}
        onAnswersChange={onAnswersChange}
        onSubmit={submit}
        submitLabel="אישור ושליחה"
        successText="הפרטים נשלחו בהצלחה. תודה רבה!"
        submitError={submitError}
      />
    </div>
  );
}
