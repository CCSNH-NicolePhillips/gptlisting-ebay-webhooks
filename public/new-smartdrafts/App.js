import { h } from 'https://esm.sh/preact@10.20.2';
import { useState } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { analyzeLive, runPairingLive, resetFolderLive, getMetricsLive } from './lib/api.js';
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
        const norm = normalizeFolderInput(folder);
        localStorage.setItem('sd.folder', norm);
        a = await analyzeLive(norm, { force });
        showToast(force ? 'Analysis loaded (live, force)' : 'Analysis loaded (live)');
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
        out = await runPairingLive();
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
    if (!window?.Dropbox) { showToast('Dropbox Chooser not available'); return; }
    window.Dropbox.choose({
      linkType: "preview",     // preview yields share links; backend can handle
      multiselect: false,
      folderselect: true,      // ask for a folder; if picker doesn't support, user will still paste manually
      success: (entries) => {
        const link = entries?.[0]?.link || '';
        if (link) {
          const norm = normalizeFolderInput(link);
          setFolder(norm);
          localStorage.setItem('sd.folder', norm);
          showToast('Folder selected');
        } else {
          showToast('No folder selected');
        }
      },
      cancel: () => {}
    });
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
            <input class="input" value=${folder} onInput=${e=>setFolder(e.currentTarget.value)} placeholder="Dropbox link or path…"/>
            <button class="btn secondary" onClick=${openDropboxChooser}>Choose…</button>
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
