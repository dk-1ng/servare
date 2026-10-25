// E2E helper page, copied next to the built extension by run.ts (never part of a build).
// Plain JS on purpose: it is loaded as-is by the browser.
const api = globalThis.browser ?? globalThis.chrome;

function connect() {
  return api.runtime.connect({ name: 'e2e' });
}

globalThis.e2e = {
  /** Sends the temporary 'download/start-direct' request over a port; resolves with {jobId}. */
  start(url, filename, tabId) {
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
        payload: { url, filename, ...(tabId !== undefined && { tabId }) },
      });
    });
  },
  /**
   * Opens the E2E copy of the popup, which targets `tabId` instead of the active tab. It opens in
   * the foreground: Firefox over BiDi does not see background tabs.
   */
  async openPopup(tabId) {
    await api.tabs.create({
      url: api.runtime.getURL(`/e2e-popup.html#tab=${tabId}`),
      active: true,
    });
  },
  /** Sends 'download/cancel' for a job. */
  cancel(jobId) {
    return new Promise((resolve, reject) => {
      const port = connect();
      const timer = setTimeout(() => reject(new Error('no response to cancel')), 30000);
      port.onMessage.addListener((message) => {
        if (message.kind !== 'response' || message.id !== '2') return;
        clearTimeout(timer);
        port.disconnect();
        if (message.ok === false) reject(new Error(JSON.stringify(message)));
        else resolve(null);
      });
      port.postMessage({ kind: 'request', id: '2', name: 'download/cancel', payload: { jobId } });
    });
  },
  /** IDs of the session rules currently installed (header replay uses 1000000+). */
  async rules() {
    return (await api.declarativeNetRequest.getSessionRules()).map((r) => r.id);
  },
  /** Closes every tab whose URL starts with `prefix`. */
  async closeTabs(prefix) {
    const tabs = await api.tabs.query({});
    await api.tabs.remove(tabs.filter((t) => (t.url ?? '').startsWith(prefix)).map((t) => t.id));
  },
  /** ID of the first tab whose URL starts with `prefix`. */
  async tabId(prefix) {
    const tabs = await api.tabs.query({});
    return tabs.find((t) => (t.url ?? '').startsWith(prefix))?.id;
  },
  async failures() {
    // Stored by the state layer as { v, data }.
    // Jobs without a tab count as private, so their failures live in storage.session.
    const read = async (area) => (await area.get('direct.failures'))['direct.failures']?.data ?? [];
    return [...(await read(api.storage.local)), ...(await read(api.storage.session))];
  },
  /** The raw per-tab media list mirrored to storage.session ({ [tabId]: { page, entries } }). */
  async tabList() {
    // Stored by the state layer as { v, data }.
    return (await api.storage.session.get('detection.tabs'))['detection.tabs']?.data ?? {};
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
