import { h } from 'https://esm.sh/preact@10.20.2';
import { useState, useMemo } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { PairingPanel } from './components/PairingPanel.js';
import { mockLoadAnalysis, mockRunPairing } from './lib/mockServer.js';

const html = htm.bind(h);

const TABS = ['Analysis','Pairing','Products (soon)','Candidates (soon)','Metrics (soon)','Logs (soon)'];

export function App() {
  const [tab, setTab] = useState('Analysis');
  const [analysis, setAnalysis] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);

  const actions = useMemo(() => ({
    loadMockAnalysis: async () => {
      setLoading(true);
      try { setAnalysis(await mockLoadAnalysis()); }
      finally { setLoading(false); }
    },
    runMockPairing: async () => {
      setLoading(true);
      try {
        const { pairing, metrics } = await mockRunPairing();
        setPairing(pairing);
        setMetrics(metrics);
        setTab('Pairing');
      } finally { setLoading(false); }
    }
  }), []);

  return html`
    <div class="page">
      <header class="topbar">
        <h1>SmartDrafts (New)</h1>
        <div class="actions">
          <button class="btn" onClick=${actions.loadMockAnalysis}>Load Analysis (Mock)</button>
          <button class="btn" onClick=${actions.runMockPairing} disabled=${!analysis}>Run Pairing (Mock)</button>
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
