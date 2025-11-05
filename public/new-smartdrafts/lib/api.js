// public/new-smartdrafts/lib/api.js

function get(url, opts={}) {
  return fetch(url, { method: 'GET', ...opts });
}
function post(url, body, opts={}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers||{}) },
    body: body ? JSON.stringify(body) : undefined,
    ...opts
  });
}

// ---- LIVE calls ----
export async function analyzeLive(folderUrl, { force=false } = {}) {
  if (!folderUrl) throw new Error('folderUrl required');
  const q = new URLSearchParams({ folder: folderUrl, force: String(!!force) });
  const r = await get(`/.netlify/functions/smartdrafts-analyze?${q}`);
  if (!r.ok) throw new Error(`analyzeLive ${r.status}: ${await r.text()}`);
  return r.json(); // VisionOutput
}

export async function runPairingLive(overrides = {}) {
  const r = await post(`/.netlify/functions/smartdrafts-pairing`, { overrides });
  if (!r.ok) throw new Error(`runPairingLive ${r.status}: ${await r.text()}`);
  return r.json(); // { pairing, metrics? }
}

export async function resetFolderLive(folderUrl) {
  if (!folderUrl) throw new Error('folderUrl required');
  const q = new URLSearchParams({ folder: folderUrl });
  const r = await post(`/.netlify/functions/smartdrafts-reset?${q}`);
  if (!r.ok) throw new Error(`resetFolderLive ${r.status}: ${await r.text()}`);
  return r.json(); // { ok, cleared }
}

export async function getMetricsLive() {
  const r = await get(`/.netlify/functions/smartdrafts-metrics`);
  if (!r.ok) throw new Error(`getMetricsLive ${r.status}: ${await r.text()}`);
  return r.json(); // Metrics
}
