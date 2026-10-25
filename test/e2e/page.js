// E2E helper page, copied next to the built extension by run.ts (never part of a build).
// Plain JS on purpose: it is loaded as-is by the browser.
const api = globalThis.browser ?? globalThis.chrome;

function connect() {
  return api.runtime.connect({ name: 'e2e' });
}

globalThis.e2e = {
  /** Sends the temporary 'download/start-direct' request over a port; resolves with {jobId}. */
  start(url, filename) {
    return new Promise((resolve, reject) => {
      const port = connect();
      const timer = setTimeout(() => reject(new Error('no response to start-direct')), 30000);
      port.onMessage.addListener((message) => {
        if (message.kind !== 'response' || message.id !== '1') return;
        clearTimeout(timer);
        port.disconnect();
        if (message.ok === false || message.error) reject(new Error(JSON.stringify(message)));
        else resolve(message.payload ?? message.result ?? message);
      });
      port.postMessage({
        kind: 'request',
        id: '1',
        name: 'download/start-direct',
        payload: { url, filename },
      });
    });
  },
  async failures() {
    // Stored by the state layer as { v, data }.
    return (await api.storage.local.get('direct.failures'))['direct.failures']?.data ?? [];
  },
  /** Names of the files in OPFS `servare-tmp`; `null` when the directory does not exist. */
  async opfs() {
    const root = await navigator.storage.getDirectory();
    let dir;
    try {
      dir = await root.getDirectoryHandle('servare-tmp');
    } catch {
      return null;
    }
    const names = [];
    for await (const [name] of dir.entries()) names.push(name);
    return names;
  },
  /** Worker host documents currently open (offscreen document or tab). */
  async hosts() {
    const url = api.runtime.getURL('/worker-host.html');
    const contexts = await api.runtime.getContexts({
      contextTypes: navigator.userAgent.includes('Firefox') ? ['TAB'] : ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    return contexts.length;
  },
  estimate() {
    return navigator.storage.estimate();
  },
  async downloads() {
    const items = await api.downloads.search({});
    return items.map((d) => ({
      id: d.id,
      filename: d.filename,
      state: d.state,
      bytes: d.fileSize,
      error: d.error,
    }));
  },
};
