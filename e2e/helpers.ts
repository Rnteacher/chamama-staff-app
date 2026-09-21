import { expect, type Page } from "@playwright/test";

export const SKIP = !process.env.E2E_ENABLED;

export const USERS = {
  admin: { email: "ronen@chamama.example", password: "Chamama2026!" },
  staff: { email: "tom@chamama.example", password: "Chamama2026!" },
  mentor: { email: "michal@chamama.example", password: "Chamama2026!" },
  master: { email: "naama@chamama.example", password: "Chamama2026!" },
  deactivated: { email: "dana@chamama.example", password: "Chamama2026!" },
};

export async function login(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByText("כניסה לבדיקות באמצעות אימייל").click();
  await page.getByLabel("אימייל").fill(user.email);
  await page.getByLabel("סיסמה").fill(user.password);
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

export async function logout(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(page).toHaveURL(/\/login/);
}
