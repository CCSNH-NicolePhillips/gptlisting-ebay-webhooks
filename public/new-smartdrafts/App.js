import { h } from 'https://unpkg.com/preact@10.20.2/dist/preact.module.js';
import { useState, useEffect } from 'https://unpkg.com/preact@10.20.2/hooks/dist/hooks.module.js';
import htm from 'https://unpkg.com/htm@3.1.1/dist/htm.module.js';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { ProductPanel } from './components/ProductPanel.js';
import { DraftsPanel } from './components/DraftsPanel.js';
import { MetricsPanel } from './components/MetricsPanel.js';
import { DebugPanel } from './components/DebugPanel.js';
import { FolderSelector } from './components/FolderSelector.js';
import { enqueueAnalyzeLive, pollAnalyzeLive, runPairingLive, resetFolderLive, getMetricsLive, createDraftsLive, pollDraftStatus, publishDraftsToEbay, callDirectPairing } from './lib/api.js';
import { mockLoadAnalysis, mockRunPairing } from './lib/mockServer.js';
import { normalizeFolderInput } from './lib/urlKey.js';

const html = htm.bind(h);

const TABS = ['Analysis','Pairing','Products','Drafts','Metrics','Comparison','Logs (soon)','Debug'];
const MAX_ANALYZE_MS = 10 * 60 * 1000; // 10 minutes timeout for analysis

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
  const [authReady, setAuthReady] = useState(false); // Track if auth is initialized
  
  // DP3: Direct pairing comparison
  const [useDirectPairing, setUseDirectPairing] = useState(false);
  const [directPairingResult, setDirectPairingResult] = useState(null);
  const [directPairingError, setDirectPairingError] = useState(null);

  // Check authentication on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        if (!window.authClient) {
          console.warn('[App] Auth client not loaded, waiting...');
          // Wait a bit for auth-client.js to load
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (window.authClient?.ensureAuth) {
          console.log('[App] Checking authentication...');
          const authed = await window.authClient.ensureAuth();
          if (!authed) {
            console.warn('[App] Not authenticated, redirecting to login');
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
            return;
          }
          
          // CRITICAL: Verify we can actually get a token before marking ready
          console.log('[App] Authentication verified, checking token availability...');
          const token = await window.authClient.getToken();
          if (!token) {
            console.error('[App] Authentication succeeded but no token available');
            setLoadingStatus('❌ Authentication error: No token available. Please refresh and login again.');
            return;
          }
          
          console.log('[App] Token available, auth ready');
          setAuthReady(true);
        } else {
          console.error('[App] Auth client not available after wait');
          setLoadingStatus('❌ Authentication not available. Please refresh.');
        }
      } catch (err) {
        console.error('[App] Auth check failed:', err);
        setLoadingStatus('❌ Authentication error: ' + (err?.message || 'Unknown'));
      }
    }
    checkAuth();
  }, []);

  function showToast(msg) { setToast(msg); setTimeout(() => setToast(''), 3000); }
  
  // DP3: Helper to extract filename from URL
  function basenameFromUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      return parts[parts.length - 1] || url;
    } catch {
      const parts = String(url).split('/');
      return parts[parts.length - 1] || String(url);
    }
  }
  
  // DP3a: Build image list for direct pairing (with fallback for cached analysis)
  function buildDirectPairingImages(analysis) {
    // Prefer imageInsights when present
    const insights = analysis?.imageInsights;
    
    // Handle imageInsights as object (Record<url, ImageInsight>)
    if (insights && typeof insights === 'object' && !Array.isArray(insights)) {
      const insightValues = Object.values(insights);
      if (insightValues.length > 0) {
        console.log('[directPairing] Using imageInsights object', { count: insightValues.length });
        return insightValues.map(insight => ({
          url: insight.displayUrl || insight.url, // Use displayUrl (full https) over normalized url
          filename: insight.filename || insight.key || insight.imageKey || basenameFromUrl(insight.displayUrl || insight.url),
        }));
      }
    }
    
    // Handle imageInsights as array
    if (Array.isArray(insights) && insights.length > 0) {
      console.log('[directPairing] Using imageInsights array', { count: insights.length });
      return insights.map(insight => ({
        url: insight.displayUrl || insight.url, // Use displayUrl (full https) over normalized url
        filename: insight.filename || insight.key || insight.imageKey || basenameFromUrl(insight.displayUrl || insight.url),
      }));
    }

    // Fallback: reconstruct from groups if we're dealing with legacy cached analysis
    if (Array.isArray(analysis?.groups) && analysis.groups.length > 0) {
      const seen = new Set();
      const images = [];

      for (const group of analysis.groups) {
        const arr = group.images || group.urls || [];
        for (const url of arr) {
          const key = String(url);
          if (seen.has(key)) continue;
          seen.add(key);
          images.push({
            url,
            filename: basenameFromUrl(url),
          });
        }
      }

      console.warn('[directPairing] Using groups fallback to build image list', {
        count: images.length,
      });

      return images;
    }

    console.warn('[directPairing] No imageInsights or groups available for direct pairing');
    return [];
  }

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
        // Check auth is ready before making API calls
        if (!authReady) {
          throw new Error('Please wait for authentication to complete, then try again.');
        }
        
        if (!folder) throw new Error('Pick a Dropbox folder/link first');
        // Folder is now a Dropbox path (not a URL), use it directly
        localStorage.setItem('dbxDefaultFolder', folder);
        
        // Enqueue job
        const analyzeStartedAt = Date.now();
        setLoadingStatus('🚀 Queueing scan...');
        showToast('Queueing scan...');
        const jobId = await enqueueAnalyzeLive(folder, { force });
        setLoadingStatus(`⏳ Polling for results...`);
        showToast(`Scan queued (${jobId.slice(0,8)}...)`);
        
        // Poll until complete (max 300 attempts = 10 minutes with 2s intervals)
        // Vision API takes 5-10 seconds per image, so allow plenty of time
        for (let i = 0; i < 300; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Check for timeout
          const elapsed = Date.now() - analyzeStartedAt;
          if (elapsed > MAX_ANALYZE_MS) {
            console.error('[UI] Analyze timeout', { jobId, folder, elapsedMs: elapsed });
            setLoadingStatus('❌ Analyze timed out. Please try again or contact support.');
            showToast('Analyze timed out after 10 minutes. Check logs or try smaller batch.');
            setLoading(false);
            return;
          }
          
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
            
            // Show cache status in UI
            if (job.cached === true) {
              setLoadingStatus('⚡ Loaded from cache');
              showToast('⚡ Analysis loaded from cache');
            } else {
              setLoadingStatus('✅ Complete (live scan)');
              showToast(force ? '✨ Analysis complete (live, force)' : '✨ Analysis complete (live)');
            }
            
            // Log analysis result with cache status
            const insightsCount = Array.isArray(a.imageInsights) 
              ? a.imageInsights.length 
              : (a.imageInsights && typeof a.imageInsights === 'object' ? Object.keys(a.imageInsights).length : 0);
            console.log('[UI] Analysis result:', {
              folder: a.folder,
              jobId: a.jobId,
              cached: a.cached,
              groups: a.groups?.length || 0,
              insights: insightsCount,
            });
            
            break;
          }
          
          if (job.state === 'error') {
            const errorMsg = job.error || 'Scan failed';
            setLoadingStatus('❌ Analyze failed');
            showToast(`❌ ${errorMsg}`);
            console.error('[UI] Analyze error', { jobId, folder, error: errorMsg });
            setLoading(false);
            return;
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
        
        // Phase 4b: Use pairingMode based on checkbox state
        const pairingMode = useDirectPairing ? 'direct-llm' : 'hp2-default';
        setLoadingStatus(`🤖 Running ${pairingMode === 'direct-llm' ? 'Direct LLM' : 'HP2'} pairing...`);
        
        // Pass folder, jobId, AND pairingMode to pairing for server-side handling
        console.log('[UI] Sending folder to pairing (server-side fetch):', folder);
        console.log('[UI] Analysis object has jobId?', !!analysis?.jobId);
        console.log('[UI] Analysis jobId value:', analysis?.jobId);
        console.log('[UI] Pairing mode:', pairingMode);
        
        out = await runPairingLive(null, { 
          folder, 
          jobId: analysis?.jobId,
          pairingMode, // Phase 4b: pass mode to server
        });
        
        showToast(`✨ Pairing complete (${out.pairingMode || pairingMode})`);
        const { pairs, products, singletons, metrics, pairingMode: usedMode } = out;
        
        // Phase 4b: Build pairing object from response
        const pairingResult = {
          pairs: pairs || [],
          products: products || [],
          singletons: singletons || [],
        };
        
        setPairing(pairingResult); 
        setMetrics(metrics || null);
        setTab('Pairing');
        
        // Phase 4b: Show which mode was actually used
        console.log('[UI] Pairing mode used:', usedMode || pairingMode);
      }
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Pairing failed'));
    } finally { 
      setLoading(false);
      setLoadingStatus('');
    }
    
    // DP3: Run direct pairing for comparison (OUTSIDE try/catch so it runs even if legacy fails)
    if (useDirectPairing && mode === 'Live' && analysis) {
      try {
        setLoading(true);
        setLoadingStatus('🔮 Running direct GPT-4o pairing...');
        setDirectPairingError(null);
        const directImages = buildDirectPairingImages(analysis);
        
        console.log('[directPairing] directImages count', directImages.length, {
          useDirectPairing,
          cached: analysis.cached,
        });
        
        if (directImages.length === 0) {
          throw new Error('No images found for direct pairing');
        }
        
        const direct = await callDirectPairing(directImages);
        console.log('[directPairing] UI got result', direct);
        setDirectPairingResult(direct);
        showToast(`✨ Direct pairing: ${direct.products.length} products`);
      } catch (err) {
        console.error('[directPairing] failed', err);
        setDirectPairingError(err.message || String(err));
        showToast('⚠️ Direct pairing failed: ' + err.message);
      } finally {
        setLoadingStatus('');
        setLoading(false);
      }
    }
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
      
      // Start background job to create drafts
      setLoadingStatus(`🚀 Starting draft generation...`);
      const startRes = await createDraftsLive(pairing.products);
      
      if (!startRes.ok || !startRes.jobId) {
        throw new Error(startRes.error || 'Failed to start draft generation');
      }
      
      const jobId = startRes.jobId;
      console.log(`[doCreateDrafts] Job started: ${jobId}`);
      showToast(`Draft generation started (${jobId.slice(0,8)}...)`);
      
      // Poll for completion
      setLoadingStatus(`⏳ Generating drafts...`);
      for (let i = 0; i < 600; i++) { // 20 minutes max (each product can take 30-60s)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const status = await pollDraftStatus(jobId);
        
        if (status.job.state === 'complete' || status.job.state === 'completed') {
          const drafts = status.job.drafts || [];
          setDrafts(drafts);
          console.log(`[doCreateDrafts] Complete: created ${drafts.length} drafts`);
          console.log(`[doCreateDrafts] Draft IDs:`, drafts.map(d => d.productId));
          showToast(`✨ Generated ${drafts.length} listing(s)!`);
          setLoadingStatus('');
          setTab('Drafts');
          return;
        }
        
        if (status.job.state === 'error') {
          throw new Error(status.job.error || 'Draft generation failed');
        }
        
        // Update progress
        if (status.job.processedProducts && status.job.totalProducts) {
          const pct = Math.round((status.job.processedProducts / status.job.totalProducts) * 100);
          setLoadingStatus(`🤖 Generating drafts... ${pct}% (${status.job.processedProducts}/${status.job.totalProducts})`);
        }
      }
      
      throw new Error('Draft generation timed out after 20 minutes - each product takes 30-60 seconds');
      
    } catch (e) {
      console.error(e); showToast('❌ ' + (e.message || 'Draft creation failed'));
      setLoadingStatus('');
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
      
      console.log(`[doPublishToEbay] Starting with ${drafts.length} drafts:`, drafts.map(d => d.productId));
      
      // Publish one item at a time to avoid 504 gateway timeout
      const chatgptJobId = `chatgpt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const allResults = [];
      
      for (let i = 0; i < drafts.length; i++) {
        const draft = drafts[i];
        setLoadingStatus(`📤 Publishing ${i + 1}/${drafts.length} to eBay...`);
        
        // Generate alphanumeric-only SKU
        const brandPrefix = (draft.brand || 'ITM').replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase();
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 7);
        const sku = `${brandPrefix}${timestamp}${random}${i}`;
        
        const group = {
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
        };
        
        try {
          const result = await publishDraftsToEbay(chatgptJobId, [group]);
          console.log(`[Publish] Success for ${draft.productId}:`, result);
          allResults.push({ draft, result, ok: result.ok });
        } catch (err) {
          console.error(`[Publish] Failed for ${draft.productId}:`, err);
          allResults.push({ draft, result: null, ok: false, error: err.message });
        }
        
        // Small delay between items
        if (i + 1 < drafts.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
      
      const successCount = allResults.filter(r => r.ok).length;
      const failCount = allResults.length - successCount;
      
      if (successCount > 0) {
        showToast(`✅ Published ${successCount}/${drafts.length} to eBay!${failCount > 0 ? ` (${failCount} failed)` : ''}`);
        setTimeout(() => {
          window.location.href = '/drafts.html';
        }, 2000);
      } else {
        throw new Error(`All ${drafts.length} items failed to publish`);
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
            <span>Force Rescan (slow — re-run Vision)</span>
          </label>
          <p class="hint" style="margin: 4px 0 8px 0; font-size: 0.85em; color: #666;">
            Leave this off for normal runs. Turn it on only if cached results look wrong.
          </p>
          <label class="check">
            <input type="checkbox" checked=${useDirectPairing} onChange=${e=>setUseDirectPairing(e.currentTarget.checked)} disabled=${mode !== 'Live'} />
            <span>Use Direct LLM Pairing (beta)</span>
          </label>
          <p class="hint" style="margin: 4px 0 8px 0; font-size: 0.85em; color: #666;">
            Direct LLM pairing ignores vision roles and lets GPT-4o determine fronts/backs autonomously.
          </p>
          ${!authReady ? html`
            <p class="hint" style="margin: 4px 0 8px 0; font-size: 0.85em; color: #f60;">
              ⏳ Authenticating... Please wait.
            </p>
          ` : null}
          <button class="btn" onClick=${doAnalyze} disabled=${!authReady && mode === 'Live'}>Analyze</button>
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
        ${!loading && tab==='Comparison' && html`
          <div class="panel">
            <h2>Pairing Comparison: Legacy vs Direct LLM</h2>
            ${!directPairingResult && !directPairingError ? html`
              <p style="color: #666; margin: 20px 0;">
                Enable "Use Direct LLM Pairing" and run pairing to see comparison.
              </p>
            ` : null}
            ${directPairingError ? html`
              <div style="background: #fee; border: 1px solid #f00; padding: 12px; margin: 12px 0; border-radius: 4px;">
                <strong>Direct pairing error:</strong> ${directPairingError}
              </div>
            ` : null}
            ${directPairingResult && !directPairingError ? html`
              <div class="comparison-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px;">
                <div style="border: 1px solid #ddd; padding: 16px; border-radius: 4px;">
                  <h3>Legacy Pairing (${pairing?.products?.length || 0} products)</h3>
                  <ul style="list-style: none; padding: 0;">
                    ${(pairing?.products || []).map((p, i) => html`
                      <li key=${i} style="margin: 12px 0; padding: 8px; background: #f9f9f9; border-radius: 4px;">
                        <div style="font-weight: bold;">${p.evidence?.product || p.productName || 'Product ' + (i+1)}</div>
                        <div style="font-size: 0.85em; color: #666; margin-top: 4px;">
                          Front: ${p.frontUrl ? p.frontUrl.split('/').pop().split('?')[0] : 'N/A'}
                        </div>
                        <div style="font-size: 0.85em; color: #666;">
                          Back: ${p.backUrl ? p.backUrl.split('/').pop().split('?')[0] : 'N/A'}
                        </div>
                      </li>
                    `)}
                  </ul>
                </div>
                <div style="border: 1px solid #ddd; padding: 16px; border-radius: 4px;">
                  <h3>Direct LLM Pairing (${directPairingResult.products?.length || 0} products)</h3>
                  <ul style="list-style: none; padding: 0;">
                    ${(directPairingResult.products || []).map((p, i) => html`
                      <li key=${i} style="margin: 12px 0; padding: 8px; background: #e8f5e9; border-radius: 4px;">
                        <div style="font-weight: bold;">${p.productName || 'Product ' + (i+1)}</div>
                        <div style="font-size: 0.85em; color: #666; margin-top: 4px;">
                          Front: ${p.frontImage || 'N/A'}
                        </div>
                        <div style="font-size: 0.85em; color: #666;">
                          Back: ${p.backImage || 'N/A'}
                        </div>
                      </li>
                    `)}
                  </ul>
                </div>
              </div>
            ` : null}
          </div>
        `}
        ${!loading && tab==='Debug' && html`<${DebugPanel} analysis=${analysis} pairing=${pairing} />`}
        ${!loading && tab!=='Analysis' && tab!=='Pairing' && tab!=='Products' && tab!=='Drafts' && tab!=='Metrics' && tab!=='Comparison' && tab!=='Debug' && html`
          <div class="placeholder">
            <p>${tab} — coming next.</p>
          </div>
        `}
      </main>
    </div>
  `;
}






