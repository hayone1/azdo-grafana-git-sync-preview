// Opens the links from the comment in a real browser, as a reviewer would, for run.mjs.
import { chromium } from "playwright";
import { grafanaAuth } from "./lib.mjs";

export async function openBrowser() {
  const browser = await chromium.launch();
  // Grafana accepts the same credentials on every request, so the frontend's own API calls are
  // authenticated without going through the login form.
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: grafanaAuth } });
  return { context, close: () => browser.close() };
}

/**
 * Opens a Grafana link and waits until the dashboard titled `title` has rendered. Grafana sets the
 * document title to "<dashboard title> - [<folder> - ]Dashboards - Grafana" once the dashboard has loaded.
 * Returns the page, still open.
 */
export async function openDashboard(context, url, title) {
  const page = await context.newPage();
  await page.goto(url.toString());
  try {
    await page.waitForFunction((t) => document.title.startsWith(`${t} - `) && document.title.endsWith(" - Dashboards - Grafana"), title, { timeout: 45_000 });
  } catch {
    const seen = await page.title().catch(() => "?");
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    await page.close();
    throw new Error(`${url} did not render '${title}'. Document title '${seen}'. Page: ${body}`);
  }
  if (await page.getByText(/could not be loaded/i).count()) throw new Error(`${url} shows an error`);
  return page;
}

/**
 * Clicks the preview banner's "View pull request" button and returns the URL it opens. The request
 * is recorded and aborted, so the test never signs in to Azure DevOps in the browser.
 */
export async function pullRequestButtonTarget(context, page, host) {
  let target;
  await context.route((u) => u.host === host, (route) => {
    target ??= route.request().url();
    return route.abort();
  });
  try {
    await page.getByText(/View pull request/).first().click({ timeout: 20_000 });
    for (let i = 0; i < 50 && !target; i++) await page.waitForTimeout(200);
  } finally {
    await context.unrouteAll({ behavior: "ignoreErrors" });
    for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});
  }
  if (!target) throw new Error("The View pull request button opened nothing");
  return target;
}
