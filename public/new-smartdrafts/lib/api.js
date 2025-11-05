// Minimal API bindings. Works even if your functions aren't hooked yet.
// If you don't have these routes, keep using mockServer and switch later.

export async function analyzeLive(folderUrl, { force = false } = {}) {
  if (!folderUrl) throw new Error("folderUrl required");
  const q = new URLSearchParams({ folder: folderUrl, force: String(!!force) });
  const r = await fetch(`/.netlify/functions/smartdrafts-analyze?${q}`, { method: 'GET' });
  if (!r.ok) throw new Error(`analyzeLive failed: ${r.status}`);
  return r.json(); // VisionOutput
}

export async function runPairingLive(overrides = {}) {
  const r = await fetch(`/.netlify/functions/smartdrafts-pairing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides })
  });
  if (!r.ok) throw new Error(`runPairingLive failed: ${r.status}`);
  return r.json(); // { pairing, metrics }
}
