// public/new-smartdrafts/components/DraftsPanel.js
import { h } from 'https://unpkg.com/preact@10.20.2/dist/preact.module.js';
import htm from 'https://unpkg.com/htm@3.1.1/dist/htm.module.js';
const html = htm.bind(h);

export function DraftsPanel({ drafts }) {
  const list = drafts || [];
  if (!list.length) return html`<div class="empty">No drafts yet. Run pairing, then create drafts.</div>`;
  
  return html`
    <div class="grid">
      ${list.map(draft => html`
        <article class="card" key=${draft.productId}>
          <div class="meta">
            <div class="row">
              <strong class="name">${draft.title}</strong>
            </div>
            <div class="small">
              ${draft.brand} · $${draft.price} · ${draft.condition}
            </div>
            ${draft.category?.title ? html`<div class="small">${draft.category.title}</div>` : null}
          </div>
          
          ${draft.description ? html`
            <div class="description" style="margin-top:8px; font-size:14px; color:#444; line-height:1.4;">
              ${draft.description}
            </div>
          ` : null}
          
          ${draft.bullets?.length ? html`
            <details class="details" open>
              <summary>Features (${draft.bullets.length})</summary>
              <ul class="list">
                ${draft.bullets.map((bullet, i) => html`<li key=${i}>${bullet}</li>`)}
              </ul>
            </details>
          ` : null}
          
          ${draft.aspects && Object.keys(draft.aspects).length > 0 ? html`
            <details class="details">
              <summary>Item Specifics (${Object.keys(draft.aspects).length})</summary>
              <div class="list" style="font-size:13px;">
                ${Object.entries(draft.aspects).map(([key, values]) => html`
                  <div key=${key} style="margin:4px 0;">
                    <strong>${key}:</strong> ${Array.isArray(values) ? values.join(', ') : values}
                  </div>
                `)}
              </div>
            </details>
          ` : null}
          
          ${draft.images?.length ? html`
            <div class="pair" style="margin-top:8px;">
              ${draft.images.slice(0, 4).map((url, i) => html`
                <img key=${i} class="thumb" src=${url} alt="Image ${i+1}" />
              `)}
            </div>
          ` : null}
        </article>
      `)}
    </div>
  `;
}






