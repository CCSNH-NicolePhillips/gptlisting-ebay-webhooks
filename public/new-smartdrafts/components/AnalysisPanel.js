import { h } from 'https://esm.sh/preact@10.20.2';
import htm from 'https://esm.sh/htm@3.1.1';
import { urlKey } from '../lib/urlKey.js';

const html = htm.bind(h);

const roleColor = (r) => ({
  front:  '#2563eb', // blue
  back:   '#16a34a', // green
  side:   '#f59e0b', // amber
  other:  '#6b7280'  // gray
}[r] || '#6b7280');

export function AnalysisPanel({ data }) {
  if (!data) {
    return html`<div class="empty">Load Analysis to see images & roles.</div>`;
  }
  const insights = data.imageInsights || [];
  return html`
    <div class="grid">
      ${insights.map((ins) => html`
        <article class="card" key=${ins.url}>
          <img class="thumb" src="${ins.url}" alt=${urlKey(ins.url)} loading="lazy" />
          <div class="meta">
            <div class="row">
              <span class="name">${urlKey(ins.url)}</span>
              <span class="chip" style=${{ background: roleColor(ins.role) }}>${ins.role || 'unknown'}</span>
            </div>
            <div class="small">
              ${ins.dominantColor ? html`<span class="dot" style=${{background: ins.dominantColor}}></span>` : null}
              ${ins.hasVisibleText ? 'Text' : 'No Text'}
              ${typeof ins.roleScore === 'number' ? html`· score ${ins.roleScore.toFixed(2)}` : null}
            </div>
            ${ins.evidenceTriggers?.length ? html`
              <details class="details">
                <summary>Evidence</summary>
                <ul class="list">
                  ${ins.evidenceTriggers.map(e => html`<li>${e}</li>`)}
                </ul>
              </details>
            ` : null}
            ${ins.visualDescription ? html`
              <details class="details">
                <summary>Description</summary>
                <div class="desc">${ins.visualDescription}</div>
              </details>
            ` : null}
          </div>
        </article>
      `)}
    </div>
  `;
}
