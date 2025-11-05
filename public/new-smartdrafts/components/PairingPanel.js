import { h } from 'https://esm.sh/preact@10.20.2';
import { useState } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { urlKey } from '../lib/urlKey.js';

const html = htm.bind(h);

export function PairingPanel({ result }) {
  const [open, setOpen] = useState(null);
  if (!result) return html`<div class="empty">Run Pairing to see results.</div>`;

  const pairs = result.pairs || [];
  const singletons = result.singletons || [];
  const debug = result.debugSummary || [];

  return html`
    <div class="panel pairing">
      <div class="stats">
        <span class="pill">pairs: ${pairs.length}</span>
        <span class="pill">singletons: ${singletons.length}</span>
      </div>

      <section>
        <h3>Pairs</h3>
        <table class="table">
          <thead>
            <tr><th>Front</th><th>Back</th><th>Score</th><th>Conf.</th><th>Brand</th><th>Product</th></tr>
          </thead>
          <tbody>
            ${pairs.map((p, i) => html`
              <tr key=${i} onClick=${() => setOpen(i)} class=${open===i ? 'active' : ''}>
                <td>${urlKey(p.frontUrl)}</td>
                <td>${urlKey(p.backUrl)}</td>
                <td>${p.matchScore.toFixed(2)}</td>
                <td>${(p.confidence ?? 0).toFixed(2)}</td>
                <td>${p.brand}</td>
                <td>${p.product}</td>
              </tr>
            `)}
          </tbody>
        </table>

        ${open!=null && pairs[open] ? html`
          <aside class="drawer">
            <h4>Evidence</h4>
            <ul class="list">
              ${pairs[open].evidence?.map((e, idx) => html`<li key=${idx}>${e}</li>`)}
            </ul>
            <button class="btn" onClick=${() => setOpen(null)}>Close</button>
          </aside>
        ` : null}
      </section>

      <section>
        <h3>Singletons</h3>
        ${singletons.length ? html`
          <ul class="list">
            ${singletons.map((s, i) => html`<li key=${i}><strong>${urlKey(s.url)}:</strong> ${s.reason}</li>`)}
          </ul>
        ` : html`<div class="muted">none</div>`}
      </section>

      <section>
        <h3>Debug Summary</h3>
        <pre class="pre">${debug.join('\n')}</pre>
      </section>
    </div>
  `;
}
