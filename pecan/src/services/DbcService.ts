import { setActiveDbcText } from '../utils/canProcessor';

const GITHUB_REPO = 'Western-Formula-Racing/DBC';
const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_DBC_READONLY_TOKEN ?? '';

export interface DBCFileInfo {
  name: string;
  path: string;
  sha: string;
  size: number;
}

export interface DBCApplyResult {
  ok: boolean;
  message: string;
  commitSha?: string;
  commitMessage?: string;
}

function githubHeaders(raw = false): HeadersInit {
  const h: HeadersInit = {
    Accept: raw ? 'application/vnd.github.v3.raw' : 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) (h as Record<string, string>)['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

/** List all .dbc files in the Western-Formula-Racing/DBC repo root. */
export async function listDBCFiles(): Promise<{ ok: boolean; files?: DBCFileInfo[]; message?: string }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/`, {
      headers: githubHeaders(),
    });
    if (!res.ok) return { ok: false, message: `GitHub ${res.status}: ${res.statusText}` };
    const items: any[] = await res.json();
    const files: DBCFileInfo[] = items
      .filter(f => f.type === 'file' && f.name.toLowerCase().endsWith('.dbc'))
      .map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size }));
    return { ok: true, files };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetch a DBC file from the repo, update the active processor DBC,
 * and cache it locally for offline use.
 */
export async function fetchAndApplyDBC(filename: string): Promise<DBCApplyResult> {
  let fileRes: Response;
  try {
    fileRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(filename)}`,
      { headers: githubHeaders(true) }
    );
  } catch (err) {
    return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!fileRes.ok) return { ok: false, message: `GitHub ${fileRes.status}: ${fileRes.statusText}` };

  const dbcText = await fileRes.text();
  if (!dbcText.trim()) return { ok: false, message: 'Fetched DBC is empty' };

  // Fetch the last commit that touched this file (non-fatal)
  let commitSha = '';
  let commitMessage = '';
  try {
    const commitRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURIComponent(filename)}&per_page=1`,
      { headers: githubHeaders() }
    );
    if (commitRes.ok) {
      const commits: any[] = await commitRes.json();
      if (commits.length > 0) {
        commitSha = commits[0].sha.slice(0, 7);
        commitMessage = commits[0].commit.message.split('\n')[0];
      }
    }
  } catch { /* non-fatal */ }

  // Update the in-memory processor DBC
  setActiveDbcText(dbcText);
  localStorage.setItem('dbc-selected-file', filename);
  localStorage.setItem('dbc-cache-active', 'true');

  // Persist to Cache API, fall back to localStorage
  try {
    const cache = await caches.open('dbc-files');
    await cache.put('cache.dbc', new Response(dbcText, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }));
  } catch {
    try { localStorage.setItem('dbc-file-content', dbcText); } catch { /* ignore */ }
  }

  const sizeKb = (dbcText.length / 1024).toFixed(1);
  return { ok: true, message: `${filename} — ${sizeKb} KB`, commitSha, commitMessage };
}
