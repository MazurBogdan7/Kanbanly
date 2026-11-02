/**
 * Lighthouse по основным экранам. Сервер: uv run python scripts/e2e_server.py (порт 8123).
 * Запуск: npm run lighthouse. Падает, если accessibility или best-practices ниже 95.
 */
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const BASE = "http://127.0.0.1:8123";
const PORT = 9333;
const MINIMUM = 95;

const browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`] });
const context = await browser.newContext({ baseURL: BASE });
const page = await context.newPage();

await page.goto("/register");
await page.getByLabel("Email").fill(`lighthouse-${Date.now()}@example.com`);
await page.getByLabel("Пароль", { exact: true }).fill("correct-horse-battery-7");
await page.getByRole("button", { name: "Создать аккаунт" }).click();
await page.getByRole("heading", { name: "Проекты", exact: true }).waitFor();

const cookies = await context.cookies();
const csrf = cookies.find((cookie) => cookie.name === "kanbanly_csrf").value;
const headers = { "X-CSRF-Token": csrf };
const post = async (path, data) =>
  (await context.request.post(`${BASE}/api/v1${path}`, { data, headers })).json();
const project = await post("/projects", { name: "Lighthouse" });
const board = await post(`/projects/${project.id}/boards`, { name: "ZIF", preset: "zif-gamedev" });

const session = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
const targets = ["/login", "/", "/templates", "/profile", `/boards/${board.id}`];

let failed = false;
for (const target of targets) {
  const result = await lighthouse(`${BASE}${target}`, {
    port: PORT,
    output: "json",
    logLevel: "error",
    onlyCategories: ["accessibility", "best-practices"],
    extraHeaders: { Cookie: session },
    disableStorageReset: true,
  });
  const { accessibility, "best-practices": bestPractices } = result.lhr.categories;
  const scores = [accessibility.score, bestPractices.score].map((score) => Math.round(score * 100));
  console.log(
    `${target.replace(board.id, ":id").padEnd(18)} a11y ${scores[0]}  best-practices ${scores[1]}`,
  );
  if (scores.some((score) => score < MINIMUM)) {
    failed = true;
    for (const category of [accessibility, bestPractices]) {
      for (const ref of category.auditRefs) {
        const audit = result.lhr.audits[ref.id];
        if (ref.weight > 0 && audit.score !== null && audit.score < 1) {
          console.log(`   - ${audit.id}: ${audit.title}`);
        }
      }
    }
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
