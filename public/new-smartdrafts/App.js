import { h } from 'https://esm.sh/preact@10.20.2';
import { useState } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { ProductPanel } from './components/ProductPanel.js';
import { MetricsPanel } from './components/MetricsPanel.js';
import { DebugPanel } from './components/DebugPanel.js';
import { FolderSelector } from './components/FolderSelector.js';
import { enqueueAnalyzeLive, pollAnalyzeLive, runPairingLive, resetFolderLive, getMetricsLive } from './lib/api.js';
import { mockLoadAnalysis, mockRunPairing } from './lib/mockServer.js';
import { normalizeFolderInput } from './lib/urlKey.js';

const html = htm.bind(h);

const TABS = ['Analysis','Pairing','Products','Candidates (soon)','Metrics','Logs (soon)','Debug'];

export function App() {
  const [tab, setTab] = useState('Analysis');
  const [mode, setMode] = useState('Mock'); // 'Mock' | 'Live'
  // Initialize folder from dbxDefaultFolder (set from index.html or previous session)
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem('dbxDefaultFolder') || '';
    } catch {
      return '';
    }
  });
  const [force, setForce] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(''); // Detailed status for loading spinner
  const [toast, setToast] = useState('');

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  // Debug helper - expose analysis to console
  function debugAnalysis() {
    if (!analysis) {
      console.log('No analysis data yet');
      return;
    }
    console.log('=== ANALYSIS DEBUG ===');
    console.log('Groups:', analysis.groups?.length);
    console.log('ImageInsights keys:', Object.keys(analysis.imageInsights || {}).length);
    console.log('\n--- GROUP URLs (first 3) ---');
    analysis.groups?.slice(0,3).forEach((g, i) => {
      console.log(`Group ${i}:`, g.brand, g.product);
      console.log('  images:', g.images);
    });
    console.log('\n--- IMAGEINSIGHT URLs (first 3) ---');
    Object.values(analysis.imageInsights || {}).slice(0,3).forEach((ins, i) => {
      console.log(`Insight ${i}:`, ins.url);
      console.log('  role:', ins.role, 'roleScore:', ins.roleScore);
    });
    console.log('\n--- FULL ANALYSIS ---');
    console.log(analysis);
    
    // Return analysis for further inspection
    return analysis;
  }

  // Expose to window for console access
  if (typeof window !== 'undefined') {
    window.debugAnalysis = debugAnalysis;
  }

  async function doAnalyze() {
    try {
      setLoading(true);
      let a;
      if (mode === 'Mock') {
        setLoadingStatus('🎲 Loading mock data...');
        a = await mockLoadAnalysis();
        showToast('✨ Analysis loaded (mock)');
      } else {
        if (!folder) throw new Error('Pick a Dropbox folder/link first');
        // Folder is now a Dropbox path (not a URL), use it directly
        localStorage.setItem('dbxDefaultFolder', folder);
        
        // Enqueue job
        setLoadingStatus('🚀 Queueing scan...');
        showToast('Queueing scan...');
        const jobId = await enqueueAnalyzeLive(folder, { force });
        setLoadingStatus(`⏳ Polling for results...`);
        showToast(`Scan queued (${jobId.slice(0,8)}...)`);
        
        // Poll until complete (max 300 attempts = 10 minutes with 2s intervals)
        // Vision API takes 5-10 seconds per image, so allow plenty of time
        for (let i = 0; i < 300; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const job = await pollAnalyzeLive(jobId);
          
          if (job.state === 'complete') {
            a = {
              groups: job.groups || [],
              imageInsights: job.imageInsights || [],
              orphans: job.orphans || [],
              cached: job.cached,
              folder: job.folder
            };
            setLoadingStatus('✅ Complete!');
            showToast(force ? '✨ Analysis complete (live, force)' : '✨ Analysis complete (live)');
            break;
          }
          
          if (job.state === 'error') {
            throw new Error(job.error || 'Scan failed');
          }
          
          // Update status toast every 10 seconds (every 5 polls)
          if (i % 5 === 0 && i > 0) {
            const elapsed = Math.floor((i * 2) / 60);
            const seconds = Math.floor((i * 2) % 60 / 10) * 10;
            const timeStr = `${elapsed}m${seconds}s`;
            setLoadingStatus(`🔍 Scanning... (${job.state}, ${timeStr} elapsed)`);
            showToast(`Scanning images... ${timeStr}`);
          }
        }
        
        if (!a) throw new Error('Scan timed out after 10 minutes');
      }
      setAnalysis(a);
      setLoadingStatus('');
      setTab('Analysis');
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Analyze failed'));
      setLoadingStatus('');
    } finally { setLoading(false); }
  }

  async function doPairing() {
    try {
      setLoading(true);
      let out;
      if (mode === 'Mock') {
        setLoadingStatus('🎲 Running mock pairing...');
        out = await mockRunPairing();
        showToast('✨ Pairing complete (mock)');
      } else {
        if (!analysis) throw new Error('Run Analyze first');
        if (!analysis.imageInsights || (typeof analysis.imageInsights === 'object' && Object.keys(analysis.imageInsights).length === 0)) {
          throw new Error('No image insights found. Try running Analyze again with Force Rescan.');
        }
        setLoadingStatus('🤖 Running GPT-4o-mini pairing...');
        
        // Convert imageInsights from object to array if needed and keep the fields pairing expects
        const insightsArray = Array.isArray(analysis.imageInsights)
          ? analysis.imageInsights
          : Object.values(analysis.imageInsights || {});

        const analysisForPairing = {
          ...analysis,
          imageInsights: insightsArray.map(x => ({
            url: x.url,
            key: x.key || x._key || x.urlKey || x.url,
            role: x.role,
            roleScore: x.roleScore,
            displayUrl: x.displayUrl || x.url,
            // NEW: pass facts/text cues through
            evidenceTriggers: Array.isArray(x.evidenceTriggers) ? x.evidenceTriggers : [],
            textExtracted: x.textExtracted || x.ocrText || '',
            visualDescription: x.visualDescription || ''
          })),
        };
        
        out = await runPairingLive(analysisForPairing);
        showToast('✨ Pairing complete (live)');
      }
      const { pairing, metrics } = out;
      setPairing(pairing); setMetrics(metrics || null);
      setLoadingStatus('');
      setTab('Pairing');
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Pairing failed'));
    } finally { setLoading(false); }
  }

  async function doHardReset() {
    try {
      if (mode !== 'Live') { showToast('⚠️ Reset only applies to Live'); return; }
      if (!folder) { showToast('⚠️ Pick a folder first'); return; }
      setLoading(true);
      setLoadingStatus('🗑️ Clearing cache...');
      const res = await resetFolderLive(folder);
      showToast(res?.ok ? `✅ Reset done (cleared ${res.cleared ?? 0})` : '✅ Reset finished');
      setAnalysis(null); setPairing(null); setMetrics(null);
      setLoadingStatus('');
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Reset failed'));
    } finally { setLoading(false); }
  }

  function openDropboxChooser() {
    showToast('Use the dropdown to select a folder');
  }

  function handleFolderChange(newFolder) {
    setFolder(newFolder);
    if (newFolder) {
      localStorage.setItem('dbxDefaultFolder', newFolder);
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
          <button class="btn secondary" onClick=${async () => { await doPairing(); setTab('Products'); }} disabled=${!analysis && mode==='Mock'}>
            Pairing → Products
          </button>
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
        ${loading && html`
          <div class="loading-spinner loading-pulse">
            <span>${loadingStatus || 'Loading…'}</span>
          </div>
        `}
        ${!loading && tab==='Analysis' && html`<${AnalysisPanel} data=${analysis} />`}
        ${!loading && tab==='Pairing' && html`<${PairingPanel} result=${pairing} />`}
        ${!loading && tab==='Products' && html`<${ProductPanel} products=${pairing?.products} />`}
        ${!loading && tab==='Metrics' && html`<${MetricsPanel} pairing=${pairing} />`}
        ${!loading && tab==='Debug' && html`<${DebugPanel} analysis=${analysis} pairing=${pairing} />`}
        ${!loading && tab!=='Analysis' && tab!=='Pairing' && tab!=='Products' && tab!=='Metrics' && html`
          <div class="placeholder">
            <p>${tab} — coming next.</p>
          </div>
        `}
      </main>
    </div>
  `;
}
