// public/new-smartdrafts/components/MetricsPanel.js
import { h } from 'https://unpkg.com/preact@10.20.2?module';
import htm from 'https://unpkg.com/htm@3.1.1?module';
const html = htm.bind(h);

export function MetricsPanel({ metrics }) {
  if (!metrics) return html`<div class="empty">No metrics yet. Run Pairing.</div>`;
  const t = metrics.totals || {};
  const th = metrics.thresholds || {};
  return html`
    <div class="panel">
      <div class="stats">
        ${Object.entries(t).map(([k,v]) => html`<span class="pill">${k}: ${v}</span>`)}
      </div>
      <h3>Thresholds</h3>
      ${Object.keys(th).length ? html`
        <table class="table">
          <tbody>
            ${Object.entries(th).map(([k,v]) => html`
              <tr><td>${k}</td><td><pre class="pre">${JSON.stringify(v,null,2)}</pre></td></tr>
            `)}
          </tbody>
        </table>
      ` : html`<div class="muted">none</div>`}
    </div>
  `;
}



