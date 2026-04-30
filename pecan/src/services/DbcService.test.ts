import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listDBCFiles, fetchAndApplyDBC } from './DbcService';

vi.mock('../utils/canProcessor', () => ({
  setActiveDbcText: vi.fn(),
}));

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('caches', {
    open: vi.fn().mockResolvedValue({ put: vi.fn() }),
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {});
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('listDBCFiles', () => {
  it('returns only .dbc files from the repo root', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { type: 'file', name: 'car.dbc', path: 'car.dbc', sha: 'abc', size: 1000 },
        { type: 'file', name: 'README.md', path: 'README.md', sha: 'def', size: 100 },
        { type: 'dir', name: 'archive', path: 'archive', sha: 'ghi', size: 0 },
      ]), { status: 200 })
    );

    const result = await listDBCFiles();

    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files![0].name).toBe('car.dbc');
  });

  it('returns an error when GitHub responds with non-200', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', { status: 401, statusText: 'Unauthorized' })
    );

    const result = await listDBCFiles();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
  });

  it('returns an error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await listDBCFiles();

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Network error');
  });
});

describe('fetchAndApplyDBC', () => {
  it('fetches DBC, calls setActiveDbcText, and returns success with commit info', async () => {
    const { setActiveDbcText } = await import('../utils/canProcessor');
    const dbcContent = 'VERSION ""\nNS_ :\nBS_:\nBU_:\n';

    mockFetch
      .mockResolvedValueOnce(new Response(dbcContent, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{
          sha: 'abc1234def56',
          commit: { message: 'Update DBC\n\nMore details' },
        }]), { status: 200 })
      );

    const result = await fetchAndApplyDBC('car.dbc');

    expect(result.ok).toBe(true);
    expect(setActiveDbcText).toHaveBeenCalledWith(dbcContent);
    expect(result.commitSha).toBe('abc1234');
    expect(result.commitMessage).toBe('Update DBC');
    expect(localStorage.setItem).toHaveBeenCalledWith('dbc-cache-active', 'true');
  });

  it('returns error when DBC content is empty', async () => {
    mockFetch.mockResolvedValueOnce(new Response('   ', { status: 200 }));

    const result = await fetchAndApplyDBC('car.dbc');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Fetched DBC is empty');
  });

  it('returns error when file fetch fails', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 404, statusText: 'Not Found' }));

    const result = await fetchAndApplyDBC('missing.dbc');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('404');
  });

  it('succeeds even when commit fetch fails (non-fatal)', async () => {
    const { setActiveDbcText } = await import('../utils/canProcessor');
    const dbcContent = 'VERSION ""\nNS_ :\nBS_:\nBU_:\n';

    mockFetch
      .mockResolvedValueOnce(new Response(dbcContent, { status: 200 }))
      .mockRejectedValueOnce(new Error('Commit fetch failed'));

    const result = await fetchAndApplyDBC('car.dbc');

    expect(result.ok).toBe(true);
    expect(setActiveDbcText).toHaveBeenCalledWith(dbcContent);
    expect(result.commitSha).toBe('');
  });
});
