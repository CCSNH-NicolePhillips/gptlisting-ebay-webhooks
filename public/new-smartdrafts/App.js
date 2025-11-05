import { h } from 'https://esm.sh/preact@10.20.2';
import { useState } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { analyzeLive, runPairingLive } from './lib/api.js';
import { mockLoadAnalysis, mockRunPairing } from './lib/mockServer.js';

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
      if (mode === 'Mock') {
        const a = await mockLoadAnalysis();
        setAnalysis(a);
        showToast('Analysis loaded (mock)');
      } else {
        if (!folder) throw new Error('Pick a folder URL/path first');
        localStorage.setItem('sd.folder', folder);
        const a = await analyzeLive(folder, { force });
        setAnalysis(a);
        showToast(force ? 'Analysis loaded (live, force)' : 'Analysis loaded (live)');
      }
      setTab('Analysis');
    } catch (e) {
      console.error(e); showToast(e.message || 'Analyze failed');
    } finally { setLoading(false); }
  }

  async function doPairing() {
    try {
      setLoading(true);
      if (mode === 'Mock') {
        const { pairing, metrics } = await mockRunPairing();
        setPairing(pairing); setMetrics(metrics);
        showToast('Pairing complete (mock)');
      } else {
        const { pairing, metrics } = await runPairingLive();
        setPairing(pairing); setMetrics(metrics);
        showToast('Pairing complete (live)');
      }
      setTab('Pairing');
    } catch (e) {
      console.error(e); showToast(e.message || 'Pairing failed');
    } finally { setLoading(false); }
  }

  function openDropboxChooser() {
    // Optional: only works if chooser script loaded in index.html
    if (!window?.Dropbox) { showToast('Dropbox Chooser not available'); return; }
    window.Dropbox.choose({
      linkType: "direct",
      multiselect: false,
      folderselect: true,
      success: (files) => {
        // Chooser returns selected folder/file entries; normalize to link or path
        const link = files?.[0]?.link || '';
        if (link) { setFolder(link); showToast('Folder selected'); }
      }
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
