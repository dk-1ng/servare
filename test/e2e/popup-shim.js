// E2E only, copied next to the built popup by run.ts (never part of a build).
// The popup asks for the active tab of the current window; opened as a tab that is the popup
// itself, so this script answers with the tab given in the URL hash (`#tab=<id>`) instead.
const api = globalThis.browser ?? globalThis.chrome;
const target = Number(new URLSearchParams(location.hash.slice(1)).get('tab'));
const query = api.tabs.query.bind(api.tabs);
api.tabs.query = async (info) =>
  info?.active && info.currentWindow ? [await api.tabs.get(target)] : query(info);
