import { h } from 'https://esm.sh/preact@10.20.2';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(h);

/**
 * Debug panel showing raw analysis/pairing data for troubleshooting
 */
export function DebugPanel({ analysis, pairing }) {
  // Helper to render collapsible JSON sections
  const JsonSection = ({ title, data, defaultExpanded = false }) => {
    const id = title.replace(/\s+/g, '-').toLowerCase();
    return html`
      <details class="debug-section" open=${defaultExpanded}>
        <summary><strong>${title}</strong> ${data ? `(${Array.isArray(data) ? data.length : Object.keys(data).length} items)` : '(empty)'}</summary>
        <pre class="debug-json">${JSON.stringify(data, null, 2)}</pre>
      </details>
    `;
  };

  if (!analysis && !pairing) {
    return html`
      <div class="debug-empty">
        <p>⚠️ No data available. Run a scan first.</p>
      </div>
    `;
  }

  // Extract key metrics
  const groupCount = analysis?.groups?.length || 0;
  const imageInsightsCount = analysis?.imageInsights 
    ? (Array.isArray(analysis.imageInsights) ? analysis.imageInsights.length : Object.keys(analysis.imageInsights).length)
    : 0;
  const pairingProductCount = pairing?.products?.length || 0;
  const pairingCandidateCount = pairing?.candidates?.length || 0;
  const pairingMetrics = pairing?.metadata?.pairingMetrics;

  return html`
    <div class="debug-container">
      <div class="debug-header">
        <h2>🐛 Debug Panel</h2>
        <p>Raw data structure for troubleshooting</p>
      </div>

      <div class="debug-summary">
        <div class="debug-stat">
          <span class="debug-label">Groups:</span>
          <span class="debug-value">${groupCount}</span>
        </div>
        <div class="debug-stat">
          <span class="debug-label">ImageInsights:</span>
          <span class="debug-value">${imageInsightsCount}</span>
        </div>
        <div class="debug-stat">
          <span class="debug-label">Products:</span>
          <span class="debug-value">${pairingProductCount}</span>
        </div>
        <div class="debug-stat">
          <span class="debug-label">Candidates:</span>
          <span class="debug-value">${pairingCandidateCount}</span>
        </div>
      </div>

      ${pairingMetrics && html`
        <div class="debug-metrics">
          <h3>Pairing Metrics</h3>
          <div class="debug-metrics-grid">
            <div><strong>Images:</strong> ${pairingMetrics.images}</div>
            <div><strong>Fronts:</strong> ${pairingMetrics.fronts}</div>
            <div><strong>Backs:</strong> ${pairingMetrics.backs}</div>
            <div><strong>Candidates:</strong> ${pairingMetrics.candidates}</div>
            <div><strong>Auto Pairs:</strong> ${pairingMetrics.autoPairs}</div>
            <div><strong>Model Pairs:</strong> ${pairingMetrics.modelPairs}</div>
            <div><strong>Singletons:</strong> ${pairingMetrics.singletons}</div>
          </div>
        </div>
      `}

      <div class="debug-sections">
        ${analysis?.groups && html`
          <${JsonSection} title="Groups" data=${analysis.groups} defaultExpanded=${true} />
        `}
        
        ${analysis?.imageInsights && html`
          <${JsonSection} 
            title="ImageInsights (${Array.isArray(analysis.imageInsights) ? 'array' : 'object'})" 
            data=${analysis.imageInsights} 
            defaultExpanded=${false} 
          />
        `}

        ${pairing?.products && html`
          <${JsonSection} title="Pairing Products" data=${pairing.products} defaultExpanded=${false} />
        `}

        ${pairing?.candidates && html`
          <${JsonSection} title="Pairing Candidates" data=${pairing.candidates} defaultExpanded=${false} />
        `}

        ${pairing?.metadata && html`
          <${JsonSection} title="Pairing Metadata" data=${pairing.metadata} defaultExpanded=${false} />
        `}

        ${analysis && html`
          <${JsonSection} title="Full Analysis Object" data=${analysis} defaultExpanded=${false} />
        `}

        ${pairing && html`
          <${JsonSection} title="Full Pairing Object" data=${pairing} defaultExpanded=${false} />
        `}
      </div>

      <div class="debug-footer">
        <p>💡 <strong>Tip:</strong> Check that Groups.images URLs match ImageInsights keys for pairing to work correctly.</p>
      </div>
    </div>
  `;
}
