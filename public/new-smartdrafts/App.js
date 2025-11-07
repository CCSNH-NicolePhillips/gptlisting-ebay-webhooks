import { h } from 'https://esm.sh/preact@10.20.2';
import { useState } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { ProductPanel } from './components/ProductPanel.js';
import { DraftsPanel } from './components/DraftsPanel.js';
import { MetricsPanel } from './components/MetricsPanel.js';
import { DebugPanel } from './components/DebugPanel.js';
import { FolderSelector } from './components/FolderSelector.js';
import { enqueueAnalyzeLive, pollAnalyzeLive, runPairingLive, resetFolderLive, getMetricsLive, createDraftsLive, publishDraftsToEbay } from './lib/api.js';
import { mockLoadAnalysis, mockRunPairing } from './lib/mockServer.js';
import { normalizeFolderInput } from './lib/urlKey.js';

const html = htm.bind(h);

const TABS = ['Analysis','Pairing','Products','Drafts','Metrics','Logs (soon)','Debug'];

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
  const [drafts, setDrafts] = useState(null);
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
              folder: job.folder,
              jobId: jobId  // Include jobId for Redis fallback in pairing
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
        
        // NEW APPROACH: Pass folder AND jobId to pairing for Redis fallback
        console.log('[UI] Sending folder to pairing (server-side fetch):', folder);
        console.log('[UI] Analysis object has jobId?', !!analysis?.jobId);
        console.log('[UI] Analysis jobId value:', analysis?.jobId);
        out = await runPairingLive(null, { folder, jobId: analysis?.jobId });
        showToast('✨ Pairing complete (live, server-side)');
      }
      const { pairing, metrics } = out;
      setPairing(pairing); setMetrics(metrics || null);
      setLoadingStatus('');
      setTab('Pairing');
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Pairing failed'));
    } finally { setLoading(false); }
  }

  async function doCreateDrafts() {
    try {
      setLoading(true);
      if (mode === 'Mock') {
        showToast('⚠️ Draft creation only works in Live mode');
        return;
      }
      if (!pairing?.products || pairing.products.length === 0) {
        throw new Error('Run Pairing first to get products');
      }
      setLoadingStatus('🤖 Generating listings with ChatGPT...');
      
      const result = await createDraftsLive(pairing.products);
      setDrafts(result.drafts || []);
      showToast(`✨ Generated ${result.summary?.succeeded || 0} listing(s)!`);
      setLoadingStatus('');
      setTab('Drafts');
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Draft creation failed'));
    } finally { setLoading(false); }
  }

  async function doPublishToEbay() {
    try {
      setLoading(true);
      if (mode === 'Mock') {
        showToast('⚠️ Publish only works in Live mode');
        return;
      }
      if (!drafts || drafts.length === 0) {
        throw new Error('Create drafts first');
      }
      if (!analysis?.jobId) {
        throw new Error('Missing jobId from analysis');
      }
      
      setLoadingStatus('📤 Publishing to eBay...');
      
      // Convert ChatGPT drafts to groups format for create-ebay-draft-user
      const groups = drafts.map((draft, index) => {
        const sku = `${draft.brand?.substring(0,3).toUpperCase() || 'ITM'}-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}-${index}`;
        
        return {
          groupId: draft.productId,
          brand: draft.brand,
          product: draft.product,
          name: draft.product,
          title: draft.title,
          description: draft.description,
          images: draft.images,
          aspects: draft.aspects,
          category: draft.category,
          categoryPath: draft.category?.title,
          price: draft.price,
          condition: draft.condition,
          sku: sku,
          // Don't pass offer object - let server use defaults
        };
      });
      
      // Use a new jobId for ChatGPT drafts to avoid old saved bindings with wrong merchantLocationKey
      const chatgptJobId = `chatgpt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const result = await publishDraftsToEbay(chatgptJobId, groups);
      
      if (result.ok) {
        const successCount = result.results?.filter((r) => r.ok).length || 0;
        showToast(`✅ Published ${successCount}/${drafts.length} draft(s) to eBay!`);
        // Redirect to drafts page
        setTimeout(() => {
          window.location.href = '/drafts.html';
        }, 2000);
      } else {
        throw new Error(result.error || 'Publish failed');
      }
      
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Publish failed'));
    } finally { setLoading(false); setLoadingStatus(''); }
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
          <button class="btn" onClick=${doCreateDrafts} disabled=${!pairing?.products?.length}>Create Drafts</button>
          <button class="btn" onClick=${doPublishToEbay} disabled=${!drafts?.length}>Publish to eBay</button>
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
        ${!loading && tab==='Drafts' && html`<${DraftsPanel} drafts=${drafts} />`}
        ${!loading && tab==='Metrics' && html`<${MetricsPanel} pairing=${pairing} />`}
        ${!loading && tab==='Debug' && html`<${DebugPanel} analysis=${analysis} pairing=${pairing} />`}
        ${!loading && tab!=='Analysis' && tab!=='Pairing' && tab!=='Products' && tab!=='Drafts' && tab!=='Metrics' && tab!=='Debug' && html`
          <div class="placeholder">
            <p>${tab} — coming next.</p>
          </div>
        `}
      </main>
    </div>
  `;
}
