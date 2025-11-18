import { h } from 'https://unpkg.com/preact@10.20.2?module';
import htm from 'https://unpkg.com/htm@3.1.1?module';
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
  
  const groups = data.groups || [];
  // imageInsights can be an object (keyed by URL) or array
  const insightsRaw = data.imageInsights || {};
  let insightsArray = Array.isArray(insightsRaw) ? insightsRaw : Object.values(insightsRaw);
  
  // De-duplicate by key and merge evidence, keeping best role
  const map = new Map();
  for (const raw of insightsArray) {
    const key = raw.key || urlKey(raw.url);
    if (!key) continue;
    
    const prev = map.get(key);
    if (!prev) { 
      map.set(key, raw); 
      continue; 
    }
    
    // Pick the one with a real role / larger |roleScore|
    const a = prev, b = raw;
    const pick = (x, y) => (Math.abs(x?.roleScore ?? 0) >= Math.abs(y?.roleScore ?? 0) ? x : y);
    const best = (a.role && !b.role) ? a : (b.role && !a.role) ? b : pick(a, b);
    
    map.set(key, {
      ...best,
      key,
      url: best.url,                            // keep real URL
      displayUrl: best.displayUrl || best.url,  // for rendering
      evidenceTriggers: [...new Set([...(a.evidenceTriggers || []), ...(b.evidenceTriggers || [])])]
    });
  }
  
  const insights = [...map.values()];
  
  // If we have groups but no insights, show groups view
  if (groups.length > 0 && insights.length === 0) {
    return html`
      <div class="panel">
        <h2>
          📊 Analysis Results
          ${data.cached && html`<span class="badge badge-soft" style="margin-left: 8px; font-size: 0.75em; font-weight: normal;">⚡ Cached (7 day cache)</span>`}
        </h2>
        <p class="muted">Found ${groups.length} product group${groups.length !== 1 ? 's' : ''}</p>
        
        <div class="grid" style="margin-top: 16px;">
          ${groups.map((group, idx) => html`
            <article class="card" key=${group.groupId || idx}>
              ${group.images?.[0] && html`
                <img class="thumb" src="${group.images[0]}" alt=${group.product || 'Product'} loading="lazy" />
              `}
              <div class="meta">
                <div class="name">${group.brand || 'Unknown Brand'}</div>
                <div class="small">${group.product || 'Unknown Product'}</div>
                ${group.variant && html`<div class="small">Variant: ${group.variant}</div>`}
                ${group.size && html`<div class="small">Size: ${group.size}</div>`}
                ${group.images?.length && html`
                  <div class="small" style="margin-top: 8px;">
                    <span class="pill">${group.images.length} image${group.images.length !== 1 ? 's' : ''}</span>
                  </div>
                `}
                ${group.categoryPath && html`
                  <details class="details">
                    <summary>Details</summary>
                    <div class="desc">
                      <strong>Category:</strong> ${group.categoryPath}<br/>
                      ${group.confidence ? html`<strong>Confidence:</strong> ${(group.confidence * 100).toFixed(0)}%<br/>` : null}
                      ${group.claims?.length ? html`<strong>Claims:</strong> ${group.claims.join(', ')}<br/>` : null}
                    </div>
                  </details>
                `}
              </div>
            </article>
          `)}
        </div>
        
        ${data.cached && html`<p class="muted" style="margin-top: 16px;">✓ Cached result</p>`}
      </div>
    `;
  }
  
  // Original imageInsights view
  return html`
    <div class="panel">
      ${data.cached && html`
        <div style="margin-bottom: 12px;">
          <span class="badge badge-soft">⚡ Cached (7 day cache)</span>
        </div>
      `}
      <div class="grid">
        ${insights.map((ins) => html`
        <article class="card" key=${ins.key || urlKey(ins.url)}>
          <img class="thumb" src="${ins.displayUrl || ins.url}" alt=${ins.key || urlKey(ins.url)} loading="lazy" />
          <div class="meta">
            <div class="row">
              <span class="name">${ins.key || urlKey(ins.url)}</span>
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
    </div>
  `;
}



