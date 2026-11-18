const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const api = "http://127.0.0.1:8080";
const web = "http://localhost:3000";
const password = "StrongPass-123456";
const suffix = Date.now();
const ownerEmail = `social-owner-${suffix}@example.test`;
const friendEmail = `social-friend-${suffix}@example.test`;

async function register(email, displayName) {
  const response = await fetch(`${api}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, displayName, password }) });
  assert.equal(response.status, 201, await response.text());
}
async function login(page, email) {
  await page.goto(web, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByRole("heading", { name: "Phòng của bạn" }).waitFor();
}

(async () => {
  await register(ownerEmail, "Social Owner");
  await register(friendEmail, "Social Friend");
  const [chrome, edge] = await Promise.all([chromium.launch({ channel: "chrome", headless: true }), chromium.launch({ channel: "msedge", headless: true })]);
  try {
    const [owner, friend] = await Promise.all([chrome.newPage(), edge.newPage()]);
    const errors = [];
    owner.on("pageerror", error => errors.push(`Chrome: ${error.message}`));
    friend.on("pageerror", error => errors.push(`Edge: ${error.message}`));
    await login(owner, ownerEmail);
    await login(friend, friendEmail);
    await friend.getByRole("button", { name: "Tham gia", exact: true }).click();
    assert.ok(await friend.getByLabel("Mật khẩu phòng (nếu có)").isVisible(), "join password must be visible on the join panel");
    await owner.getByRole("button", { name: "Bạn bè & hồ sơ" }).click();
    await owner.getByLabel("Email của người bạn muốn kết bạn").fill(friendEmail);
    await owner.getByRole("button", { name: "Gửi lời mời" }).click();
    await owner.getByText("Đang chờ chấp nhận").waitFor();
    await friend.getByRole("button", { name: "Bạn bè & hồ sơ" }).click();
    await friend.locator(".social-hub").getByText("Đã gửi lời mời cho bạn").waitFor({ timeout: 15000 });
    await friend.getByRole("button", { name: "Chấp nhận" }).click();
    await friend.getByRole("button", { name: "Đóng bạn bè" }).click();
    await owner.getByRole("button", { name: "Đóng bạn bè" }).click();
    await owner.getByLabel("Tên phòng").fill(`Social Room ${suffix}`);
	await owner.getByRole("button", { name: "+ Đặt khóa phòng" }).click();
	await owner.locator(".room-entry-form").first().locator('input[type="password"]').fill("room-secret");
    await owner.locator(".room-entry-form .primary").click();
    await owner.getByRole("heading", { name: `Social Room ${suffix}` }).waitFor();
	const memberPanel = await owner.locator(".member-panel").boundingBox();
	const dock = await owner.locator(".account-dock").boundingBox();
	assert.ok(memberPanel && dock && memberPanel.y + memberPanel.height < dock.y, "room members should remain visible above the account dock");
	await owner.getByRole("button", { name: "Cài đặt khóa phòng, đang khóa" }).click();
	await owner.getByRole("region", { name: "Cài đặt khóa phòng" }).waitFor();
	if (process.env.COMPACT_DESKTOP_SCREENSHOT) await owner.screenshot({ path: process.env.COMPACT_DESKTOP_SCREENSHOT, fullPage: true });
	await owner.keyboard.press("Escape");
	await owner.getByRole("region", { name: "Cài đặt khóa phòng" }).waitFor({ state: "hidden" });
    const roomId = await owner.locator(".room-id").textContent();
    assert.ok(roomId);
    await friend.reload({ waitUntil: "networkidle" });
    await friend.locator(".recent-rooms").filter({ hasText: `Social Room ${suffix}` }).waitFor({ timeout: 15000 });
    await friend.locator(".recent-rooms").filter({ hasText: `Social Room ${suffix}` }).getByRole("button").click();
    assert.equal(await friend.getByLabel("Mã phòng").inputValue(), roomId, "locked suggestion should fill the room ID");
    assert.equal(await friend.getByLabel("Mật khẩu phòng (nếu có)").evaluate((element) => element === document.activeElement), true, "locked suggestion should focus password field");
    await friend.getByRole("button", { name: "Tham gia phòng" }).click();
    await friend.locator(".join-room-form").getByRole("alert").getByText("Mật khẩu phòng không đúng hoặc còn thiếu").waitFor();
    await friend.getByLabel("Mật khẩu phòng (nếu có)").fill("room-secret");
    await friend.getByRole("button", { name: "Tham gia phòng" }).click();
    await friend.getByRole("heading", { name: `Social Room ${suffix}` }).waitFor();
    await owner.getByRole("button", { name: "Bạn bè & hồ sơ" }).click();
    await owner.locator(".social-friend").getByRole("button", { name: "Nhắn tin" }).click();
    await owner.getByRole("textbox", { name: "Tin nhắn cho Social Friend" }).fill("Hello from Chrome social DM");
    await owner.locator(".social-chat-form").getByRole("button", { name: "Gửi" }).click();
    await friend.getByRole("button", { name: /Bạn bè & hồ sơ/ }).getByText("1").waitFor({ timeout: 15000 });
    await friend.getByRole("button", { name: /Bạn bè & hồ sơ/ }).click();
    await friend.locator(".social-friend").getByRole("button", { name: /Nhắn tin/ }).click();
    await friend.locator(".social-chat").getByText("Hello from Chrome social DM").waitFor();
    await friend.getByLabel("Tên hiển thị").fill("Social Friend Updated");
	const avatarBase64 = await friend.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32; const context = canvas.getContext("2d"); context.fillStyle = "#2f63ea"; context.fillRect(0, 0, 32, 32); return canvas.toDataURL("image/jpeg").split(",")[1]; });
	await friend.locator(".social-profile input[type=file]").setInputFiles({ name: "avatar.jpg", mimeType: "image/jpeg", buffer: Buffer.from(avatarBase64, "base64") });
    await friend.getByRole("button", { name: "Lưu hồ sơ" }).click();
    await friend.getByText("Đã lưu hồ sơ").waitFor();
	assert.ok((await friend.locator(".social-profile img.social-avatar").getAttribute("src")).startsWith("data:image/jpeg;base64,"));
	await friend.getByRole("button", { name: "Đóng bạn bè" }).click();
	await friend.locator(".social-hub").waitFor({ state: "hidden" });
	await friend.setViewportSize({ width: 375, height: 812 });
	assert.ok(await friend.getByRole("button", { name: "Bạn bè & hồ sơ" }).isVisible(), "compact account dock should remain usable on mobile");
	assert.equal(await friend.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile view must not scroll horizontally");
	if (process.env.COMPACT_MOBILE_SCREENSHOT) await friend.screenshot({ path: process.env.COMPACT_MOBILE_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: "ok", browsers: ["chrome", "msedge"], roomId, ownerEmail, friendEmail }));
  } finally { await chrome.close(); await edge.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
