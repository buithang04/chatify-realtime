const assert = require("node:assert/strict");

const prometheus = process.env.PROMETHEUS_URL || "http://127.0.0.1:9090";
const mediaMetrics = process.env.MEDIA_METRICS_URL || "http://127.0.0.1:3002/metrics";

async function request(path) {
  const response = await fetch(`${prometheus}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function waitFor(path, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await request(path); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 1000)); }
  }
  throw lastError;
}

async function main() {
  const mediaResponse = await fetch(mediaMetrics);
  const mediaText = await mediaResponse.text();
  if (!mediaResponse.ok) throw new Error(`${mediaMetrics} -> ${mediaResponse.status}: ${mediaText.slice(0, 200)}`);
  for (const metric of ["chatify_media_ice_failures_total", "chatify_media_dtls_failures_total"]) {
    if (!mediaText.includes(metric)) throw new Error(`missing media metric ${metric}`);
  }

  const targets = await waitFor("/api/v1/targets");
  const activeTargets = targets.data.activeTargets;
  const healthByJob = new Map(activeTargets.map((target) => [target.labels.job, target.health]));
  for (const job of ["chatify-api", "chatify-signaling", "chatify-media", "chatify-outbox"]) {
    assert.equal(healthByJob.get(job), "up", `${job} is not up`);
  }

  const rules = await waitFor("/api/v1/rules");
  const ruleNames = new Set(rules.data.groups.flatMap((group) => group.rules.map((rule) => rule.name)));
  for (const rule of ["ChatifyAPIUnreachable", "ChatifySignalingUnreachable", "ChatifyMediaWorkerUnreachable", "ChatifyMediaICEFailures", "ChatifyOutboxUnreachable", "ChatifyOutboxBacklogHigh", "ChatifyDatabasePoolExhaustion", "ChatifyObjectStorageErrors", "ChatifyAPI5xxRate"]) {
    assert.equal(ruleNames.has(rule), true, `missing alert rule ${rule}`);
  }
  console.log(JSON.stringify({ status: "ok", targets: Object.fromEntries(healthByJob), alertRules: ruleNames.size }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
