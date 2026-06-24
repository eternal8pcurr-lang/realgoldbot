// One-off end-to-end UI test: drives the live chat like a real visitor,
// triggers the email-capture box, submits a unique test email, and confirms
// the in-page "thank you". Uses the system Chrome via playwright-core.
import { chromium } from "playwright-core";

const SITE = "https://realgold-assistant.pages.dev";
const CODE = "RG1";
const TOKEN = "uitest-" + Date.now();
const TEST_EMAIL = `${TOKEN}@example.com`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(45000);

try {
  log("opening", SITE);
  await page.goto(SITE, { waitUntil: "domcontentloaded" });

  // --- access gate ---
  await page.fill("#code", CODE);
  await page.click("#enter");
  await page.waitForSelector("#app:not(.hidden)");
  log("passed access gate");

  // --- ask a question that routes to a human (triggers [[OFFER_EMAIL]]) ---
  const q =
    "What are the exact projected annual returns and the minimum investment amount and deal terms? Please have someone from the team contact me.";
  await page.fill("#input", q);
  await page.click("#send");
  log("sent question, waiting for assistant + email capture box…");

  // The capture box appears only when the assistant offers email.
  await page.waitForSelector(".capture input", { timeout: 90000 });
  log("email capture box appeared ✓");

  // --- fill the capture box like a visitor (email + message) ---
  const MESSAGE = `Hi team — this is an automated UI test (${TOKEN}). Please call me about minimum investment and timelines.`;
  await page.fill(".capture input", TEST_EMAIL);
  await page.fill(".capture textarea", MESSAGE);
  await page.click(".capture button");

  // --- confirm the in-page success state ---
  await page.waitForSelector(".capture .ok", { timeout: 30000 });
  const ok = (await page.textContent(".capture .ok"))?.trim();
  log("in-page confirmation:", JSON.stringify(ok));

  console.log("\nRESULT_OK " + TEST_EMAIL);
} catch (e) {
  console.error("\nRESULT_FAIL", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
