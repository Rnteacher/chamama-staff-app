import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StudentDataTable from "@/components/tables/StudentDataTable";

/**
 * RENDERED-COMPONENT tests for the desktop home student table:
 * the major must be VISIBLE in the rendered DOM, not merely present in data.
 */

const baseRow = {
  student_id: "44444444-4444-4444-4444-444444444401",
  student_name: "מאיה דרורי",
  group_name: "קבוצת זית",
  has_project: false,
  project_major_name: null as string | null,
  intent_text: null,
  primary_master_name: null,
  master_names: null,
  status: null,
  status_source: null,
  last_report_at: null,
  intervention: null,
  mentor_last_meeting_at: null,
  mentor_last_status: null,
  master_last_meeting_at: null,
  master_last_status: null,
  mentor_next_meeting_at: null,
  mentor_next_meeting_weekday: null,
  mentor_next_meeting_time: null,
  master_next_meeting_at: null,
  master_next_meeting_weekday: null,
  master_next_meeting_time: null,
};

const COLUMNS = [
  "student_name", "group_name", "project_major_name", "primary_master_name",
  "status", "last_report_at", "intervention",
];

describe("StudentDataTable renders the major column", () => {
  it("shows the supplied major NAME in the desktop table DOM", () => {
    const html = renderToStaticMarkup(
      <StudentDataTable
        title="כל החניכים"
        rows={[{ ...baseRow, project_major_name: "קולנוע" }]}
        columns={COLUMNS}
      />
    );
    expect(html).toContain("מגמה"); // the column header exists
    expect(html).toContain("קולנוע"); // the major NAME is rendered
    expect(html).not.toContain("לא במגמה");
  });

  it("shows the major name even WITHOUT a current project (fallback row)", () => {
    const html = renderToStaticMarkup(
      <StudentDataTable
        title="כל החניכים"
        rows={[{ ...baseRow, has_project: false, project_major_name: "ביוטכנולוגיה" }]}
        columns={COLUMNS}
      />
    );
    expect(html).toContain("ביוטכנולוגיה");
  });

  it("renders — for a student with no major anywhere", () => {
    const html = renderToStaticMarkup(
      <StudentDataTable title="כל החניכים" rows={[{ ...baseRow }]} columns={COLUMNS} />
    );
    expect(html).toContain("—");
    expect(html).not.toContain("לא במגמה");
  });

  it("renders לא במגמה for a project student without a major", () => {
    const html = renderToStaticMarkup(
      <StudentDataTable
        title="כל החניכים"
        rows={[{ ...baseRow, has_project: true, project_major_name: null }]}
        columns={COLUMNS}
      />
    );
    expect(html).toContain("לא במגמה");
  });
});
