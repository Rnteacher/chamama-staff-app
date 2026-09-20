"use client";

import { useMemo, useState } from "react";
import ConversationalForm, {
  type Question, type Answers,
} from "@/components/conversational/ConversationalForm";
import { createBrowserClient } from "@/lib/supabase/browser";
import {
  type FormSchema, type FormField,
  isFieldVisible, evaluateCondition, validateFormAnswers,
} from "@/lib/form-schema";

interface PublicFormWizardProps {
  token: string;
  schema: FormSchema;
  subjectName: string | null;
}

export default function PublicFormWizard({ token, schema, subjectName }: PublicFormWizardProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const questions: Question[] = useMemo(
    () =>
      schema.fields
        .filter((f) => f.type !== "heading" && isFieldVisible(f, answers))
        .map((f) => fieldToQuestion(f, answers)),
    [schema, answers]
  );

  async function submit(): Promise<void> {
    setSubmitError(null);
    const supabase = createBrowserClient();
    const { error } = await supabase.rpc("public_form_submit", {
      p_token: token,
      p_answers: answers,
    });
    if (error) {
      setSubmitError("השליחה נכשלה. נסו שוב.");
      throw error;
    }
  }

  return (
    <ConversationalForm
      questions={questions}
      answers={answers}
      onAnswersChange={setAnswers}
      onSubmit={submit}
      submitLabel="שליחה"
      successText="הטופס נשלח בהצלחה. תודה רבה!"
      submitError={submitError}
      disabled={false}
    />
  );
}

function fieldToQuestion(f: FormField, answers: Record<string, unknown>): Question {
  const base: Question = {
    id: f.key,
    title: f.label,
    subtitle: f.help,
    type: "text",
    optional: !f.required,
    options: f.options,
  };
  switch (f.type) {
    case "short_text": return { ...base, type: "text", maxLength: 500 };
    case "long_text": return { ...base, type: "textarea", maxLength: 2000 };
    case "single_choice": return { ...base, type: "single-select", options: f.options };
    case "multiple_choice": return { ...base, type: "multi-select", options: f.options };
    case "yes_no": return { ...base, type: "single-select", options: [{ value: "yes", label: "כן" }, { value: "no", label: "לא" }] };
    case "gyr": return { ...base, type: "single-select", options: [{ value: "green", label: "ירוק" }, { value: "yellow", label: "צהוב" }, { value: "red", label: "אדום" }] };
    case "number": return { ...base, type: "text" };
    case "scale": return { ...base, type: "single-select", options: [1,2,3,4,5].map((n) => ({ value: String(n), label: String(n) })) };
    case "date": return { ...base, type: "text" };
    case "time": return { ...base, type: "text" };
    case "datetime": return { ...base, type: "text" };
    case "acknowledgement": return { ...base, type: "single-select", options: [{ value: "yes", label: "אישור" }] };
    default: return base;
  }
}
