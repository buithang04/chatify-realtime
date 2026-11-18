const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const web = process.env.WEB_URL || "http://localhost:3000";
const api = process.env.API_URL || "http://127.0.0.1:8080";
const password = "StrongPass-123456";
const diagnostics = { consoleErrors: [], mediaFailures: [] };

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} -> ${response.status}: ${text}`);
  return body;
}

async function createUser(label) {
  const email = `browser-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}@example.test`;
  await json(`${api}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, displayName: label }),
  });
  const login = await json(`${api}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { email, token: login.tokens.accessToken };
}

async function login(page, user) {
  await page.goto(web, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByRole("heading", { name: "Phòng của bạn" }).waitFor();
}

async function main() {
  const owner = await createUser("Browser Owner");
  const guest = await createUser("Browser Guest");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const contextOptions = { permissions: ["camera", "microphone"], viewport: { width: 1280, height: 900 } };
  const ownerContext = await browser.newContext(contextOptions);
  const guestContext = await browser.newContext(contextOptions);
  const ownerPage = await ownerContext.newPage();
  const guestPage = await guestContext.newPage();
  for (const [page, label] of [[ownerPage, "owner"], [guestPage, "guest"]]) {
    page.on("response", (response) => {
      const expectedAnonymousRefresh = response.url().includes("/api/v1/auth/refresh") && response.status() === 422;
      if (response.status() >= 400 && !expectedAnonymousRefresh) diagnostics.consoleErrors.push(`${label} ${response.status()}: ${response.url()}`);
      if (response.url().includes(":3002/") && response.status() >= 400) diagnostics.mediaFailures.push(`${label} ${response.status()}: ${response.url()}`);
    });
    page.on("pageerror", (error) => diagnostics.consoleErrors.push(`${label} pageerror: ${error.message}`));
  }

  try {
    await login(ownerPage, owner);
    await ownerPage.getByLabel("Tên phòng").fill("Browser E2E Room");
    await ownerPage.getByLabel("Kiểu phòng").selectOption("direct");
    const roomResponsePromise = ownerPage.waitForResponse((response) => response.url().includes("/api/v1/rooms") && response.request().method() === "POST" && response.status() === 201);
    await ownerPage.locator(".room-entry-form .primary").click();
    const roomResponse = await roomResponsePromise;
    const roomId = (await roomResponse.json()).room.id;
    await ownerPage.getByRole("heading", { name: "Browser E2E Room" }).waitFor();
    await ownerPage.getByText("1-1 CALL").waitFor();
    await login(guestPage, guest);
    await guestPage.getByRole("button", { name: "Tham gia", exact: true }).click();
    await guestPage.getByLabel("Mã phòng").fill(roomId);
    await guestPage.getByRole("button", { name: "Tham gia phòng" }).click();
    await guestPage.getByRole("heading", { name: "Browser E2E Room" }).waitFor();

    await ownerPage.getByRole("textbox", { name: "Tin nhắn" }).fill("browser realtime hello");
    await ownerPage.getByRole("button", { name: "Gửi tin nhắn" }).click();
    await guestPage.getByText("browser realtime hello").waitFor();

    await ownerPage.getByRole("button", { name: "Bật camera" }).click();
    await guestPage.locator(".remote-grid .remote-video").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await guestPage.locator(".remote-grid .remote-video").count(), 1);
    await ownerPage.getByRole("button", { name: "Sao chép ID" }).click();
    await ownerPage.getByRole("button", { name: "Đã sao chép" }).waitFor();
    await guestPage.getByRole("button", { name: "Rời phòng" }).click();
    await guestPage.getByRole("heading", { name: "Tạo một phòng để bắt đầu" }).waitFor();

    await ownerPage.getByRole("button", { name: "+ Tạo / tham gia phòng khác" }).click();
    await ownerPage.getByLabel("Kiểu phòng").selectOption("livestream");
    await ownerPage.getByLabel("Tên phòng").fill("Browser E2E Livestream");
    const liveResponsePromise = ownerPage.waitForResponse((response) => response.url().includes("/api/v1/rooms") && response.request().method() === "POST" && response.status() === 201);
    await ownerPage.locator(".room-entry-form .primary").click();
    const liveRoomId = (await (await liveResponsePromise).json()).room.id;
    await ownerPage.getByRole("heading", { name: "Browser E2E Livestream" }).waitFor();
    await guestPage.getByRole("textbox", { name: "Mã phòng" }).fill(liveRoomId);
    await guestPage.getByRole("button", { name: "Tham gia phòng" }).click();
    await guestPage.getByRole("heading", { name: "Browser E2E Livestream" }).waitFor();
    await guestPage.getByText("Chỉ xem").waitFor();
    assert.equal(await guestPage.getByRole("button", { name: "Bật camera" }).isDisabled(), true);
    await ownerPage.getByRole("button", { name: "Bật camera" }).click();
    await guestPage.locator(".remote-grid .remote-video").waitFor({ state: "visible", timeout: 15_000 });
  } finally {
    await ownerContext.close();
    await guestContext.close();
    await browser.close();
  }
  assert.deepEqual(diagnostics.consoleErrors, []);
  console.log(JSON.stringify({ status: "ok", browser: true }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.stack || error.message, ...diagnostics }));
  process.exitCode = 1;
});
