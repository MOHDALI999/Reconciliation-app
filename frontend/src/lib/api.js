/**
 * Where the API lives. In development this is empty (Vite proxies /api).
 * When deployed, the host rewrites the placeholder to a proxy path such as
 * "port/8787", which must be resolved from the site root.
 */
function resolveApiBase() {
  const buildTime = import.meta.env?.VITE_API_BASE;
  const configured = typeof window !== 'undefined' ? window.__RECON_API__ : '';
  if (!configured || configured.startsWith('__PORT')) {
    // Static hosts (e.g. Vercel) have no sandbox proxy; VITE_API_BASE points at the API.
    return buildTime ? String(buildTime).replace(/\/+$/, '') : '';
  }
  if (/^https?:\/\//.test(configured)) return configured.replace(/\/+$/, '');
  // A relative proxy path is resolved against the page, not the domain root,
  // because the app may be served from a sub-path.
  return new URL(`${configured.replace(/^\/+|\/+$/g, '')}/`, document.baseURI).toString().replace(/\/+$/, '');
}

export const API_BASE = resolveApiBase();

async function request(path, { method = 'GET', body, signal, form } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    headers: form ? undefined : body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

export const api = {
  health: () => request('/api/health'),

  uploadFile(file, signal) {
    const form = new FormData();
    form.append('file', file);
    return request('/api/files', { method: 'POST', form, signal });
  },

  setView: (fileId, view) => request(`/api/files/${fileId}/view`, { method: 'POST', body: view }),
  removeFile: (fileId) => request(`/api/files/${fileId}`, { method: 'DELETE' }),

  startRun: (payload) => request('/api/runs', { method: 'POST', body: payload }),
  getRun: (runId) => request(`/api/runs/${runId}`),
  cancelRun: (runId) => request(`/api/runs/${runId}`, { method: 'DELETE' }),

  getRows: ({ runId, tab, offset, limit, search }, signal) =>
    request(`/api/runs/${runId}/rows?tab=${tab}&offset=${offset}&limit=${limit}&search=${encodeURIComponent(search || '')}`, { signal }),

  exportUrl: (runId, tab, full) => `${API_BASE}/api/runs/${runId}/export?tab=${tab}${full ? '&full=1' : ''}`,
  /** Excel: sheet 1 = data as in the files + Match / Not Match, sheet 2 = details, sheet 3 = run info. */
  exportXlsxUrl: (runId, tab) => `${API_BASE}/api/runs/${runId}/export.xlsx?tab=${tab}`,
};

/** Live progress for a run. Returns an unsubscribe function. */
export function subscribeRun(runId, onState) {
  const source = new EventSource(`${API_BASE}/api/runs/${runId}/events`);
  source.onmessage = (event) => {
    try { onState(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
  };
  source.onerror = () => source.close();
  return () => source.close();
}
