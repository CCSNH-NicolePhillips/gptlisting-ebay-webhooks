import { h } from 'https://esm.sh/preact@10.20.2';
import { useState } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { FolderSelector } from './components/FolderSelector.js';
import { enqueueAnalyzeLive, pollAnalyzeLive, runPairingLive, resetFolderLive, getMetricsLive } from './lib/api.js';
import { mockLoadAnalysis, mockRunPairing } from './lib/mockServer.js';
import { normalizeFolderInput } from './lib/urlKey.js';

const html = htm.bind(h);

const TABS = ['Analysis','Pairing','Products (soon)','Candidates (soon)','Metrics (soon)','Logs (soon)'];

export function App() {
  const [tab, setTab] = useState('Analysis');
  const [mode, setMode] = useState('Mock'); // 'Mock' | 'Live'
  const [folder, setFolder] = useState(localStorage.getItem('sd.folder') || '');
  const [force, setForce] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 2000); }

  async function doAnalyze() {
    try {
      setLoading(true);
      let a;
      if (mode === 'Mock') {
        a = await mockLoadAnalysis();
        showToast('Analysis loaded (mock)');
      } else {
        if (!folder) throw new Error('Pick a Dropbox folder/link first');
        // Folder is now a Dropbox path (not a URL), use it directly
        localStorage.setItem('sd.folder', folder);
        
        // Enqueue job
        showToast('Queueing scan...');
        const jobId = await enqueueAnalyzeLive(folder, { force });
        showToast(`Scan queued (${jobId.slice(0,8)}...) - polling...`);
        
        // Poll until complete (max 60 attempts = 60 seconds)
        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const job = await pollAnalyzeLive(jobId);
          
          if (job.state === 'complete') {
            a = {
              groups: job.groups || [],
              imageInsights: [], // scan doesn't return imageInsights
              cached: job.cached,
              folder: job.folder
            };
            showToast(force ? 'Analysis complete (live, force)' : 'Analysis complete (live)');
            break;
          }
          
          if (job.state === 'error') {
            throw new Error(job.error || 'Scan failed');
          }
          
          // Update status toast every 5 seconds
          if (i % 5 === 0 && i > 0) {
            showToast(`Scanning... (${job.state})`);
          }
        }
        
        if (!a) throw new Error('Scan timed out after 60 seconds');
      }
      setAnalysis(a);
      setTab('Analysis');
    } catch (e) {
      console.error(e); showToast(e.message || 'Analyze failed');
    } finally { setLoading(false); }
  }

  async function doPairing() {
    try {
      setLoading(true);
      let out;
      if (mode === 'Mock') {
        out = await mockRunPairing();
        showToast('Pairing complete (mock)');
      } else {
        if (!analysis) throw new Error('Run Analyze first');
        out = await runPairingLive(analysis);
        showToast('Pairing complete (live)');
      }
      const { pairing, metrics } = out;
      setPairing(pairing); setMetrics(metrics || null);
      setTab('Pairing');
    } catch (e) {
      console.error(e); showToast(e.message || 'Pairing failed');
    } finally { setLoading(false); }
  }

  async function doHardReset() {
    try {
      if (mode !== 'Live') { showToast('Reset only applies to Live'); return; }
      if (!folder) { showToast('Pick a folder first'); return; }
      setLoading(true);
      const res = await resetFolderLive(folder);
      showToast(res?.ok ? `Reset done (cleared ${res.cleared ?? 0})` : 'Reset finished');
      setAnalysis(null); setPairing(null); setMetrics(null);
    } catch (e) {
      console.error(e); showToast(e.message || 'Reset failed');
    } finally { setLoading(false); }
  }

  function openDropboxChooser() {
    showToast('Use the dropdown to select a folder');
  }

  function handleFolderChange(newFolder) {
    setFolder(newFolder);
    if (newFolder) {
      localStorage.setItem('sd.folder', newFolder);
    }
  }

  return html`
    <div class="page">
      <header class="topbar">
        <h1>SmartDrafts (New)</h1>
        <div class="actions">
          <label class="toggle">
            <span>Mode:</span>
            <select value=${mode} onChange=${e=>setMode(e.currentTarget.value)}>
              <option>Mock</option><option>Live</option>
            </select>
          </label>
          <label class="folder">
            <span>Folder:</span>
            ${mode === 'Live' 
              ? html`<${FolderSelector} value=${folder} onChange=${handleFolderChange} disabled=${loading} />`
              : html`<input class="input" value=${folder} onInput=${e=>setFolder(e.currentTarget.value)} placeholder="Mock mode - any value…" disabled=${loading}/>`
            }
          </label>
          <label class="check">
            <input type="checkbox" checked=${force} onChange=${e=>setForce(e.currentTarget.checked)} />
            <span>Force Rescan</span>
          </label>
          <button class="btn" onClick=${doAnalyze}>Analyze</button>
          <button class="btn secondary" onClick=${doHardReset}>Hard Reset</button>
          <button class="btn" onClick=${doPairing} disabled=${!analysis && mode==='Mock'}>Run Pairing</button>
        </div>
      </header>

      <nav class="tabs">
        ${TABS.map(name => html`
          <button
            class=${'tab' + (tab===name ? ' active' : '')}
            onClick=${() => setTab(name)}
          >${name}</button>
        `)}
      </nav>

      <main class="content">
        ${toast && html`<div class="toast">${toast}</div>`}
        ${loading && html`<div class="loading">Loading…</div>`}
        ${!loading && tab==='Analysis' && html`<${AnalysisPanel} data=${analysis} />`}
        ${!loading && tab==='Pairing' && html`<${PairingPanel} result=${pairing} />`}
        ${!loading && tab!=='Analysis' && tab!=='Pairing' && html`
          <div class="placeholder">
            <p>${tab} — coming next.</p>
          </div>
        `}
      </main>
    </div>
  `;
}
