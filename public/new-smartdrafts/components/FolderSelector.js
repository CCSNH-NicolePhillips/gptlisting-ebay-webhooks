import { h } from 'https://esm.sh/preact@10.20.2';
import { useState, useEffect } from 'https://esm.sh/preact@10.20.2/hooks';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(h);

/**
 * Dropbox folder selector component
 * Loads folders from dropbox-list-folders endpoint
 */
export function FolderSelector({ value, onChange, disabled }) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadFolders();
  }, []);

  async function loadFolders() {
    setLoading(true);
    setError(null);
    try {
      const exec = window.authClient?.authFetch ?? fetch;
      const url = new URL('/.netlify/functions/dropbox-list-folders', window.location.origin);
      url.searchParams.set('recursive', '1');
      
      const res = await exec(url.toString());
      if (!res.ok) {
        throw new Error(`Failed to load folders: ${res.status}`);
      }
      
      const data = await res.json();
      const entries = Array.isArray(data?.folders) ? data.folders : [];
      
      // Extract unique paths
      const unique = new Map();
      entries.forEach((entry) => {
        const path = entry?.path_display || entry?.path_lower || entry?.name || '';
        if (path) {
          unique.set(path, path);
        }
      });
      
      const paths = Array.from(unique.keys()).sort((a, b) => a.localeCompare(b));
      setFolders(paths);
      
      // Check for stored default folder (set from index.html or previous session)
      const stored = localStorage.getItem('dbxDefaultFolder') || '';
      
      // Priority: 1) current value, 2) stored default, 3) first folder
      if (!value && stored && paths.includes(stored)) {
        onChange(stored);
      } else if (!value && paths.length > 0) {
        onChange(paths[0]);
      }
    } catch (err) {
      console.error('Failed to load Dropbox folders:', err);
      setError(err.message || 'Failed to load folders');
    } finally {
      setLoading(false);
    }
  }

  function handleChange(e) {
    const selected = e.currentTarget.value;
    onChange(selected);
    // Save as default folder for future sessions
    if (selected) {
      localStorage.setItem('dbxDefaultFolder', selected);
    }
  }

  if (loading) {
    return html`
      <select disabled>
        <option>Loading Dropbox folders...</option>
      </select>
    `;
  }

  if (error) {
    return html`
      <div style="display: flex; gap: 8px; align-items: center;">
        <select disabled>
          <option>Error loading folders</option>
        </select>
        <button class="btn secondary" onClick=${loadFolders}>Retry</button>
      </div>
    `;
  }

  if (folders.length === 0) {
    return html`
      <select disabled>
        <option>No Dropbox folders found</option>
      </select>
    `;
  }

  return html`
    <select value=${value} onChange=${handleChange} disabled=${disabled}>
      ${folders.map(path => html`
        <option key=${path} value=${path}>${path}</option>
      `)}
    </select>
  `;
}
