const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const web = process.env.WEB_URL || "http://localhost:3000";
const api = process.env.API_URL || "http://127.0.0.1:8080";
const password = "StrongPass-123456";

async function request(path, body) {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function login(page, label) {
  const email = `cross-browser-${label}-${Date.now()}@example.test`;
  await request("/api/v1/auth/register", { email, password, displayName: label });
  await page.goto(web, { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByRole("heading", { name: "Phòng của bạn" }).waitFor();
}

async function main() {
  const browsers = await Promise.all([
    chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }),
    chromium.launch({ channel: "msedge", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }),
  ]);
  const errors = [];
  const contexts = await Promise.all(browsers.map((browser) => browser.newContext({
    permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"],
    viewport: { width: 1280, height: 900 },
  })));
  try {
    const [chrome, edge] = await Promise.all(contexts.map((context) => context.newPage()));
    for (const [page, label] of [[chrome, "Chrome"], [edge, "Edge"]]) {
      page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
      page.on("response", async (response) => {
        if (response.status() >= 400 && !response.url().includes("/api/v1/auth/refresh")) errors.push(`${label}: ${response.status()} ${response.url()} ${response.url().includes(":3002/") ? await response.text().catch(() => "") : ""}`);
      });
    }
    await login(chrome, "chrome");
    await login(edge, "edge");
    await chrome.getByLabel("Tên phòng").fill("Chrome Edge Room");
    await chrome.getByLabel("Kiểu phòng").selectOption("group");
    const created = chrome.waitForResponse((response) => response.url().endsWith("/api/v1/rooms") && response.status() === 201);
    await chrome.locator(".room-entry-form .primary").click();
    const id = (await (await created).json()).room.id;
    await chrome.getByRole("heading", { name: "Chrome Edge Room" }).waitFor();
    await chrome.getByRole("button", { name: "Sao chép ID" }).click();
    const clipboardId = await chrome.evaluate(() => navigator.clipboard.readText());
    assert.equal(clipboardId, id, "Copy button must place full room ID on clipboard");
    assert.ok(await chrome.getByText(`ID ${id}`, { exact: false }).isVisible(), "Full ID should be visible to share manually");
    await chrome.reload({ waitUntil: "networkidle" });
    await chrome.getByRole("heading", { name: "Chrome Edge Room" }).waitFor();
    await edge.getByRole("button", { name: "Tham gia", exact: true }).click();
    await edge.getByLabel("Mã phòng").fill(clipboardId);
    await edge.getByRole("button", { name: "Tham gia phòng" }).click();
    await edge.getByRole("heading", { name: "Chrome Edge Room" }).waitFor();
    await chrome.locator(".member-panel").getByText("edge", { exact: true }).waitFor({ timeout: 5000 });
    await edge.locator(".member-panel").getByText("chrome", { exact: true }).waitFor().catch(async (error) => {
      console.error("Edge roster at failure:", await edge.locator(".member-panel").innerText().catch(() => "missing"));
      console.error("Edge alerts at failure:", await edge.getByRole("alert").allTextContents());
      throw error;
    });
    if (process.env.ROSTER_SCREENSHOT) await chrome.screenshot({ path: process.env.ROSTER_SCREENSHOT, fullPage: true });
    await edge.reload({ waitUntil: "networkidle" });
    await edge.getByRole("heading", { name: "Chrome Edge Room" }).waitFor();
    const thirdContext = await browsers[0].newContext({ viewport: { width: 1280, height: 900 } });
    contexts.push(thirdContext);
    const third = await thirdContext.newPage();
    third.on("pageerror", (error) => errors.push(`Third: ${error.message}`));
    await login(third, "third");
    await third.getByRole("button", { name: "Tham gia", exact: true }).click();
    await third.getByLabel("Mã phòng").fill(id);
    await third.getByRole("button", { name: "Tham gia phòng" }).click();
    await third.getByRole("heading", { name: "Chrome Edge Room" }).waitFor();
    await chrome.getByRole("button", { name: "Nhắn riêng cho edge" }).click();
    await chrome.getByRole("textbox", { name: "Tin nhắn riêng cho edge" }).fill("secret for edge only");
    await chrome.getByRole("button", { name: "Gửi tin nhắn" }).click();
    await edge.getByRole("button", { name: "Nhắn riêng cho chrome" }).getByText("1", { exact: true }).waitFor({ timeout: 10000 });
    await edge.getByRole("status").getByText("Tin nhắn riêng từ chrome", { exact: false }).waitFor({ timeout: 5000 });
    await edge.getByRole("button", { name: "Ẩn chat" }).getByText("1", { exact: true }).waitFor();
    await edge.getByRole("button", { name: "Nhắn riêng cho chrome" }).click();
    await edge.getByText("secret for edge only").waitFor({ timeout: 10000 });
    assert.equal(await edge.getByRole("button", { name: "Nhắn riêng cho chrome" }).getByText("1", { exact: true }).count(), 0, "opening private chat clears unread badge");
    assert.equal(await third.getByText("secret for edge only").count(), 0, "third member must not receive private chat");
    await edge.getByRole("textbox", { name: "Tin nhắn riêng cho chrome" }).fill("private reply");
    await edge.getByRole("button", { name: "Gửi tin nhắn" }).click();
    await chrome.getByText("private reply").waitFor({ timeout: 10000 });
    await third.getByRole("button", { name: "Nhắn riêng cho chrome" }).click();
    assert.equal(await third.getByText("secret for edge only").count(), 0, "third member must not read another pair's history");
    await third.getByRole("button", { name: "Rời phòng" }).click();
    await third.getByRole("heading", { name: "Tạo một phòng để bắt đầu" }).waitFor();
    await chrome.getByRole("button", { name: "Chat phòng" }).click();
    await edge.getByRole("button", { name: "Chat phòng" }).click();
    await chrome.getByRole("textbox", { name: "Tin nhắn" }).fill("hello from Chrome");
    await chrome.getByRole("button", { name: "Gửi tin nhắn" }).click();
    await edge.getByText("hello from Chrome").waitFor();
    await edge.getByRole("textbox", { name: "Tin nhắn" }).fill("hello from Edge");
    await edge.getByRole("button", { name: "Gửi tin nhắn" }).click();
    await chrome.getByText("hello from Edge").waitFor();
    await chrome.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      let frame = 0;
      setInterval(() => {
        context.fillStyle = "#dc3030";
        context.fillRect(0, 0, canvas.width / 2, canvas.height);
        context.fillStyle = "#295be8";
        context.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
        context.fillStyle = "white";
        context.font = "bold 96px sans-serif";
        context.fillText("LEFT", 120, 360);
        context.fillText("RIGHT", 760, 360);
        context.fillRect(550 + (frame++ % 40), 20, 30, 30);
      }, 100);
      navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(15);
    });
    await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).click();
    try { await chrome.getByRole("button", { name: "Dừng chia sẻ" }).waitFor({ timeout: 12_000 }); }
    catch (error) { console.error("sender screen failure", { alerts: await chrome.locator("[role=alert]").allTextContents(), errors }); throw error; }
    await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "visible", timeout: 15_000 });
    try {
      await edge.waitForFunction(() => [...document.querySelectorAll(".remote-grid video")].some((video) => video.videoWidth >= 320 && video.currentTime > 0), null, { timeout: 15_000 });
    } catch (error) {
      const describe = (selector) => [...document.querySelectorAll(selector)].map((video) => ({ width: video.videoWidth, time: video.currentTime, ready: video.readyState, paused: video.paused, tracks: [...(video.srcObject?.getTracks() || [])].map((track) => ({ state: track.readyState, muted: track.muted, enabled: track.enabled })) }));
      console.error("screen diagnostics", JSON.stringify({ sender: await chrome.evaluate(describe, ".local-video"), receiver: await edge.evaluate(describe, ".remote-grid video") }));
      throw error;
    }
    const screenBox = await edge.locator(".remote-grid .remote-video").first().boundingBox();
    const stageBox = await edge.locator(".video-stage").boundingBox();
    assert.ok(screenBox && stageBox && screenBox.width >= stageBox.width * 0.75, `shared screen should fill stage: video=${screenBox?.width} stage=${stageBox?.width}`);
    await edge.getByRole("button", { name: "Toàn màn hình" }).click();
    await edge.waitForFunction(() => document.fullscreenElement?.classList.contains("stage-grid"), null, { timeout: 5000 });
    assert.equal(await edge.locator(".remote-grid .featured-screen").evaluate((video) => getComputedStyle(video).objectFit), "cover", "shared screen should fill fullscreen by default");
    await edge.getByRole("button", { name: "Hiện toàn bộ" }).click();
    assert.equal(await edge.locator(".remote-grid .featured-screen").evaluate((video) => getComputedStyle(video).objectFit), "contain", "viewer should be able to show uncropped source");
    await edge.getByRole("button", { name: "Lấp đầy" }).click();
    assert.equal(await chrome.locator(".screen-preview").evaluate((video) => video.srcObject.getVideoTracks()[0].contentHint), "detail", "screen capture should prioritize visual detail");
    const expandedScreen = await edge.locator(".remote-grid .featured-screen").boundingBox({ timeout: 4000 });
    const fullscreenSize = await edge.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(expandedScreen && expandedScreen.width >= fullscreenSize.width * .9 && expandedScreen.height >= fullscreenSize.height * .85,
      `shared screen must occupy the fullscreen viewport: video=${JSON.stringify(expandedScreen)} viewport=${JSON.stringify(fullscreenSize)}`);
    if (process.env.FULLSCREEN_SCREENSHOT) await edge.screenshot({ path: process.env.FULLSCREEN_SCREENSHOT });
    assert.equal(await edge.locator(".chat-panel").count(), 0, "fullscreen shared screen should start without a chat overlay");
    await chrome.getByRole("textbox", { name: "Tin nhắn" }).fill("hidden chat notification");
    await chrome.getByRole("button", { name: "Gửi tin nhắn" }).click();
    await edge.getByRole("status").getByText("Có tin nhắn mới trong phòng").waitFor({ timeout: 5000 });
    await edge.getByRole("status").getByText("Có tin nhắn mới trong phòng").waitFor({ state: "detached", timeout: 5000 });
    await edge.getByRole("button", { name: "Hiện chat" }).click();
    await edge.getByText("hidden chat notification").waitFor();
    await edge.getByRole("button", { name: "Thoát toàn màn hình" }).click();
    await edge.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
    await edge.locator(".chat-panel").waitFor({ state: "visible" });
    const orientation = async (page, selector) => page.locator(selector).first().evaluate((video) => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0);
      const left = [...context.getImageData(Math.floor(canvas.width * .2), Math.floor(canvas.height * .2), 1, 1).data];
      const right = [...context.getImageData(Math.floor(canvas.width * .8), Math.floor(canvas.height * .2), 1, 1).data];
      return { left, right, transform: getComputedStyle(video).transform };
    });
    const senderOrientation = await orientation(chrome, ".screen-preview");
    const receiverOrientation = await orientation(edge, ".remote-grid .remote-video");
    assert.ok(senderOrientation.left[0] > senderOrientation.left[2] && senderOrientation.right[2] > senderOrientation.right[0], `sender preview mirrored: ${JSON.stringify(senderOrientation)}`);
    assert.ok(receiverOrientation.left[0] > receiverOrientation.left[2] && receiverOrientation.right[2] > receiverOrientation.right[0], `receiver video mirrored: ${JSON.stringify(receiverOrientation)}`);
    assert.equal(senderOrientation.transform, "none");
    assert.equal(receiverOrientation.transform, "none");
    if (process.env.SCREEN_SCREENSHOT) await edge.screenshot({ path: process.env.SCREEN_SCREENSHOT, fullPage: true });
    await chrome.getByRole("button", { name: "Dừng chia sẻ" }).click();
    await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "detached", timeout: 5000 });
    await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).click();
    await chrome.getByRole("button", { name: "Dừng chia sẻ" }).waitFor({ timeout: 10000 });
    await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "visible", timeout: 10000 });
    await edge.waitForFunction(() => [...document.querySelectorAll(".remote-grid video")].some((video) => video.videoWidth >= 320 && video.currentTime > 0), null, { timeout: 10000 });
    assert.equal(await edge.locator(".remote-grid .remote-video").count(), 1, "receiver should show only the second screen share");
    for (let share = 3; share <= 4; share += 1) {
      await chrome.getByRole("button", { name: "Dừng chia sẻ" }).click();
      await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "detached", timeout: 5000 });
      await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).click();
      await chrome.getByRole("button", { name: "Dừng chia sẻ" }).waitFor({ timeout: 10000 });
      await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await edge.locator(".remote-grid .remote-video").count(), 1, `receiver should show only share ${share}`);
    }
    await chrome.getByRole("button", { name: "Bật camera" }).click();
    assert.equal(await chrome.locator('video[aria-label="Preview camera của bạn"]').evaluate((video) => getComputedStyle(video).transform), "none");
    await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "visible", timeout: 15_000 });
    await edge.locator('.remote-grid video[aria-label^="Video remote"]').waitFor({ state: "visible", timeout: 15000 });
    await edge.getByRole("button", { name: "Toàn màn hình" }).click();
    await edge.waitForFunction(() => document.fullscreenElement?.classList.contains("screen-focused"), null, { timeout: 5000 });
    assert.equal(await edge.locator(".chat-panel").count(), 0, "fullscreen should hide chat even when camera is also active");
    assert.equal(await edge.locator(".remote-grid .featured-screen").count(), 1, "fullscreen should focus the shared screen when camera is also on");
    assert.equal(await edge.locator('.remote-grid video[aria-label^="Video remote"]').isVisible(), false, "camera should not shrink the shared screen in fullscreen");
    await edge.getByRole("button", { name: "Thoát toàn màn hình" }).click();
    await edge.locator(".chat-panel").waitFor({ state: "visible" });
    await edge.getByRole("button", { name: "Bật mic" }).click();
	await edge.getByRole("button", { name: "Chọn microphone" }).click();
    await edge.locator('meter[aria-label="Mức âm thanh microphone"]').waitFor({ state: "visible" });
    await edge.waitForFunction(() => Number(document.querySelector('meter[aria-label="Mức âm thanh microphone"]')?.value) > 0, null, { timeout: 5000 });
    assert.equal(await edge.getByRole("radiogroup", { name: "Chọn microphone" }).getByRole("radio").first().isDisabled(), true, "input selection must wait until microphone stops");
	await edge.keyboard.press("Escape");
    assert.equal(await edge.getByRole("button", { name: "Mở danh sách loa" }).isVisible(), true);
    if (process.env.AUDIO_SCREENSHOT) await edge.screenshot({ path: process.env.AUDIO_SCREENSHOT, fullPage: true });
    await chrome.locator(".remote-grid audio").waitFor({ state: "attached", timeout: 15_000 });
    const remoteAudio = await chrome.locator(".remote-grid audio").first().evaluate(async (audio) => {
      const track = audio.srcObject?.getAudioTracks()[0];
      const context = new AudioContext();
      const source = context.createMediaStreamSource(audio.srcObject);
      const analyser = context.createAnalyser();
      source.connect(analyser);
      await context.resume();
      const samples = new Uint8Array(analyser.fftSize);
      let peak = 0;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        analyser.getByteTimeDomainData(samples);
        for (const value of samples) peak = Math.max(peak, Math.abs(value - 128));
      }
      await context.close();
      return { peak, muted: track?.muted, readyState: track?.readyState, paused: audio.paused, currentTime: audio.currentTime };
    });
    assert.ok(remoteAudio.peak > 5, `remote microphone is silent: ${JSON.stringify(remoteAudio)}`);
    assert.equal(remoteAudio.paused, false, `remote audio did not autoplay: ${JSON.stringify(remoteAudio)}`);
    await chrome.getByRole("button", { name: "Tắt loa" }).click();
    await chrome.waitForFunction(() => document.querySelector(".remote-grid audio")?.muted === true);
    assert.equal(await edge.getByRole("button", { name: "Tắt mic" }).isVisible(), true, "muting local speakers must not mute the other user's mic");
    await chrome.getByRole("button", { name: "Bật loa" }).click();
    await chrome.waitForFunction(() => document.querySelector(".remote-grid audio")?.muted === false);
    await chrome.locator(".member-row.speaking").filter({ hasText: "edge" }).waitFor({ timeout: 5000 });
    await edge.getByRole("button", { name: "Tắt mic" }).click();
    await chrome.locator(".member-row.speaking").filter({ hasText: "edge" }).waitFor({ state: "detached", timeout: 5000 });
    await chrome.getByRole("button", { name: "Rời phòng" }).click();
    await chrome.getByRole("heading", { name: "Tạo một phòng để bắt đầu" }).waitFor();
    await edge.locator(".remote-grid .remote-video").first().waitFor({ state: "detached", timeout: 5000 });
    await chrome.getByRole("region", { name: "Phòng đã vào gần đây" }).getByRole("button", { name: /Chrome Edge Room/ }).waitFor({ timeout: 5000 });
    await edge.locator(".member-panel").getByText("chrome", { exact: true }).waitFor({ state: "detached" });
    await edge.locator(".member-row").filter({ hasText: "edge" }).getByText("Chủ phòng").waitFor({ timeout: 5000 });
    await edge.getByText("quyền owner", { exact: false }).waitFor();
    assert.equal(await edge.getByRole("alert").count(), 0, "owner handoff should refresh the member list without an error");
    await edge.getByRole("button", { name: "Đăng xuất" }).click();
    await edge.getByRole("button", { name: "Đăng nhập" }).waitFor();
    await chrome.getByRole("region", { name: "Phòng đã vào gần đây" }).getByRole("button", { name: /Chrome Edge Room/ }).waitFor({ state: "detached", timeout: 15000 });
    await edge.reload({ waitUntil: "networkidle" });
    await edge.getByRole("button", { name: "Đăng nhập" }).waitFor();
    await chrome.getByLabel("Tên phòng").fill("Screen Error Room");
    await chrome.locator(".room-entry-form .primary").click();
    await chrome.getByRole("heading", { name: "Screen Error Room" }).waitFor();
    await chrome.route("**/routers", (route) => route.abort());
    await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).click();
    await chrome.getByRole("alert").getByText("Không thể kết nối máy chủ media", { exact: false }).waitFor({ timeout: 5000 });
    await chrome.unroute("**/routers");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).click();
      await chrome.getByRole("button", { name: "Dừng chia sẻ" }).waitFor({ timeout: 10_000 });
      await chrome.getByRole("button", { name: "Dừng chia sẻ" }).click();
      await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).waitFor({ state: "visible" });
    }
    await chrome.evaluate(() => { navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException("Permission denied", "NotAllowedError"); }; });
    await chrome.getByRole("button", { name: "Chia sẻ màn hình" }).click();
    await chrome.getByRole("alert").getByText("Trình duyệt từ chối chia sẻ màn hình (NotAllowedError)", { exact: false }).waitFor({ timeout: 5000 });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: "ok", browsers: ["chrome", "msedge"], roomId: id }));
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await Promise.all(browsers.map((browser) => browser.close()));
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
