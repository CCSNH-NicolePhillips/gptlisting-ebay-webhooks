// public/new-smartdrafts/components/ProductPanel.js
import { h } from 'https://unpkg.com/preact@10.20.2/dist/preact.module.js';
import htm from 'https://unpkg.com/htm@3.1.1/dist/htm.module.js';
import { urlKey } from '../lib/urlKey.js';
const html = htm.bind(h);

export function ProductPanel({ products }) {
  const list = products || [];
  if (!list.length) return html`<div class="empty">No products yet. Run Pairing.</div>`;
  return html`
    <div class="grid">
      ${list.map(p => html`
        <article class="card" key=${p.productId}>
          <div class="meta">
            <div class="row">
              <span class="name">${p.brand} · ${p.product}${p.variant ? ` · ${p.variant}` : ''}</span>
            </div>
            ${p.size ? html`<div class="small">size: ${p.size}</div>` : null}
            ${p.categoryPath ? html`<div class="small">${p.categoryPath}</div>` : null}
          </div>
          <div class="pair">
            <img class="thumb" src=${p.heroDisplayUrl || p.frontUrl} alt=${urlKey(p.heroDisplayUrl || p.frontUrl)} />
            <img class="thumb" src=${p.backDisplayUrl || p.backUrl}  alt=${urlKey(p.backDisplayUrl || p.backUrl)} />
          </div>
          ${p.extras?.length ? html`
            <div class="extras">
              ${p.extras.slice(0,4).map(u => html`<img class="thumb sm" src=${u} alt=${urlKey(u)} />`)}
            </div>
          ` : null}
          ${p.evidence?.length ? html`
            <details class="details">
              <summary>Evidence</summary>
              <ul class="list">
                ${p.evidence.map((e,i) => html`<li key=${i}>${e}</li>`)}
              </ul>
            </details>
          ` : null}
        </article>
      `)}
    </div>
  `;
}






