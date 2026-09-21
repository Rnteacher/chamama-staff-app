"use client";

import { useCallback, useEffect, useState } from "react";
import ConversationalForm, {
  type Question,
  type Answers,
} from "@/components/conversational/ConversationalForm";
import { createBrowserClient } from "@/lib/supabase/browser";
import {
  fetchLgregStudents,
  fetchLgregExisting,
  submitLgreg,
  type PublicLgregGroup,
} from "@/lib/lgreg-public";
import {
  describeConflictHe,
  firstConflict,
  slotsOverlap,
  type WeeklySlot,
} from "@/lib/schedule";

export interface LgregWizardProps {
  token: string;
  title: string;
  homeGroups: { id: string; name: string }[];
  learningGroups: PublicLgregGroup[];
}

function toSlots(group: PublicLgregGroup): WeeklySlot[] {
  return group.slots.map((s) => ({
    weekday: s.weekday,
    startTime: s.start_time,
    endTime: s.end_time,
  }));
}

/**
 * Public learning-group registration wizard (no login).
 * Conflict prevention is MANDATORY: a group whose weekly slots overlap ANY
 * weekly slot of an already-selected group is disabled with a Hebrew
 * explanation. The server recomputes conflicts canonically at submit.
 */
export default function LearningGroupRegistrationWizard({
  token,
  title,
  homeGroups,
  learningGroups,
}: LgregWizardProps) {
  const [answers, setAnswers] = useState<Answers>({});
  const [students, setStudents] = useState<
    { id: string; first_name: string; last_name: string }[]
  >([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const homeGroupId =
    typeof answers.home_group_id === "string" ? answers.home_group_id : null;
  const studentId =
    typeof answers.student_id === "string" ? answers.student_id : null;

  const loadStudents = useCallback(
    async (gid: string) => {
      await Promise.resolve();
      setLoadingStudents(true);
      try {
        const supabase = createBrowserClient();
        setStudents(await fetchLgregStudents(supabase, token, gid));
      } finally {
        setLoadingStudents(false);
      }
    },
    [token]
  );

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (homeGroupId && !cancelled) void loadStudents(homeGroupId);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [homeGroupId, loadStudents]);

  const onAnswersChange = useCallback((next: Answers) => {
    if (next.home_group_id !== answers.home_group_id) {
      // changing the home group invalidates the student choice
      next = { ...next, student_id: undefined, group_ids: undefined };
      setStudents([]);
    } else if (next.student_id !== answers.student_id) {
      // keep selection per-student clean; prefilled below when available
      next = { ...next, group_ids: undefined };
    }
    setAnswers(next);
  }, [answers.home_group_id, answers.student_id]);

  // edit/resubmit: prefill the student's existing selection in THIS window
  useEffect(() => {
    let cancelled = false;
    if (!studentId) return;
    const timer = setTimeout(async () => {
      await Promise.resolve();
      try {
        const supabase = createBrowserClient();
        const existing = await fetchLgregExisting(supabase, token, studentId);
        if (!cancelled && existing.status === "ok" && existing.selected) {
          setAnswers((prev) =>
            prev.student_id === studentId
              ? { ...prev, group_ids: existing.selected }
              : prev
          );
        }
      } catch {
        // prefill is best-effort only
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [studentId, token]);

  const selectedIds: string[] = Array.isArray(answers.group_ids)
    ? (answers.group_ids as string[])
    : [];

  const selectedGroups = learningGroups.filter((g) => selectedIds.includes(g.id));

  const groupOptions = learningGroups.map((g) => {
    const isSelected = selectedIds.includes(g.id);
    if (isSelected) return { value: g.id, label: g.name };
    const candidateSlots = toSlots(g);
    const conflict = firstConflict(candidateSlots, selectedGroups.map((sg) => ({
      name: sg.name,
      slots: toSlots(sg),
    })));
    if (conflict) {
      return {
        value: g.id,
        label: g.name,
        disabled: true,
        hint: describeConflictHe(conflict.name, conflict.slot),
      };
    }
    return { value: g.id, label: g.name };
  });

  const questions: Question[] = [
    {
      id: "home_group_id",
      title: "באיזו קבוצה אתם?",
      type: "single-select",
      options: homeGroups.map((g) => ({ value: g.id, label: g.name })),
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
      id: "group_ids",
      title: "לאילו קבוצות למידה תרצו להרשם?",
      subtitle: "אפשר לבחור יותר מקבוצה אחת — כל עוד אין חפיפה בין המפגשים",
      type: "multi-select",
      options: groupOptions,
      validate: (a) => {
        const arr = Array.isArray(a.group_ids) ? (a.group_ids as string[]) : [];
        if (arr.length === 0) return "בחרו לפחות קבוצת למידה אחת";
        const known = learningGroups.filter((g) => arr.includes(g.id));
        if (known.length !== arr.length) return "אחת מהקבוצות אינה זמינה";
        // client-side double check (the server recomputes canonically)
        for (let i = 0; i < known.length; i++) {
          for (let j = i + 1; j < known.length; j++) {
            for (const sa of toSlots(known[i])) {
              for (const sb of toSlots(known[j])) {
                if (slotsOverlap(sa, sb)) {
                  return `לא ניתן לבחור ב-${known[i].name} וב-${known[j].name} יחד — המפגשים חופפים`;
                }
              }
            }
          }
        }
        return null;
      },
    },
  ];

  async function submit() {
    setSubmitError(null);
    const supabase = createBrowserClient();
    const res = await submitLgreg(supabase, {
      token,
      studentId: String(answers.student_id ?? ""),
      homeGroupId: String(answers.home_group_id ?? ""),
      selectedGroupIds: selectedIds,
    });
    if (res.status !== "ok") {
      setSubmitError(
        res.status === "closed"
          ? "תקופת ההרשמה נסגרה בינתיים."
          : res.status === "not_open"
            ? "ההרשמה נסגרה זה עתה. נסו שוב מוקדם יותר בפעם הבאה."
            : res.status === "invalid"
              ? "הקישור אינו תקין. פנו להנהלה."
              : res.message ?? "השליחה נכשלה. נסו שוב."
      );
      throw new Error(res.status);
    }
  }

  return (
    <div className="w-full max-w-lg">
      <div className="mb-5 text-center">
        <p className="text-sm font-semibold text-muted">הרשמה לקבוצות למידה</p>
        <h1 className="mt-1 text-xl font-extrabold">{title}</h1>
      </div>
      <ConversationalForm
        questions={questions}
        answers={answers}
        onAnswersChange={onAnswersChange}
        onSubmit={submit}
        submitLabel="אישור ושליחה"
        successText="ההרשמה נשלחה בהצלחה. תודה רבה!"
        submitError={submitError}
      />
    </div>
  );
}
