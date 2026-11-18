const { chromium } = require("playwright");

async function probe(channel) {
  const browser = await chromium.launch({ channel, headless: true, args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--enable-usermedia-screen-capturing",
  ] });
  try {
    const page = await browser.newPage();
    await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      window.__captureResults = [];
      const button = document.createElement("button");
      button.id = "native-capture-probe";
      button.textContent = "Capture probe";
      button.addEventListener("click", async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          window.__captureResults.push({ ok: true, tracks: stream.getVideoTracks().length });
          stream.getTracks().forEach((track) => track.stop());
        } catch (error) {
          window.__captureResults.push({ ok: false, name: error.name, message: error.message });
        }
      });
      document.body.append(button);
    });
    for (const attempt of [1, 2]) {
      await page.locator("#native-capture-probe").click();
      await page.waitForFunction((count) => window.__captureResults.length >= count, attempt, { timeout: 8000 });
    }
    const results = await page.evaluate(() => window.__captureResults);
    const email = `native-capture-${channel}-${Date.now()}@example.test`;
    const password = "StrongPass-123456";
    const registered = await fetch("http://127.0.0.1:8080/api/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, displayName: channel }) });
    if (!registered.ok) throw new Error(`registration failed: ${registered.status}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mật khẩu").fill(password);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.getByRole("heading", { name: "Phòng của bạn" }).waitFor();
    await page.locator(".room-entry-form .primary").click();
    await page.getByRole("heading", { name: "Phòng của tôi" }).waitFor();
    const appResults = [];
    for (const attempt of [1, 2]) {
      await page.getByRole("button", { name: "Chia sẻ màn hình" }).click();
      try {
        await page.getByRole("button", { name: "Dừng chia sẻ" }).waitFor({ timeout: 8000 });
        appResults.push({ attempt, ok: true });
        await page.getByRole("button", { name: "Dừng chia sẻ" }).click();
      } catch {
        appResults.push({ attempt, ok: false, alerts: await page.locator("[role=alert]").allTextContents() });
        break;
      }
    }
    return { channel, results, appResults };
  } finally { await browser.close(); }
}

(async () => {
  for (const channel of ["chrome", "msedge"]) console.log(JSON.stringify(await probe(channel)));
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
