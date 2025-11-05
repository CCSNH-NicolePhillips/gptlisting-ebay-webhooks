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
// Uses production-ready smartdrafts-scan-bg (enqueue) - caller must poll scan-status
export async function enqueueAnalyzeLive(folderUrl, { force=false } = {}) {
  if (!folderUrl) throw new Error('folderUrl required');
  
  const r = await post(`/.netlify/functions/smartdrafts-scan-bg`, { 
    path: folderUrl, 
    force 
  });
  if (!r.ok) throw new Error(`Enqueue failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  
  if (!data.jobId) throw new Error('No jobId returned from scan-bg');
  return data.jobId;
}

export async function pollAnalyzeLive(jobId) {
  if (!jobId) throw new Error('jobId required');
  
  const r = await get(`/.netlify/functions/smartdrafts-scan-status?jobId=${jobId}`);
  if (!r.ok) throw new Error(`Status check failed ${r.status}: ${await r.text()}`);
  
  const job = await r.json();
  
  if (job.state === 'error') {
    throw new Error(job.error || 'Scan job failed');
  }
  
  return job; // { state: 'pending'|'running'|'complete', groups?, orphans?, cached?, folder?, signature? }
}

export async function runPairingLive(analysis, overrides = {}) {
  const r = await post(`/.netlify/functions/smartdrafts-pairing`, { analysis, overrides });
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
