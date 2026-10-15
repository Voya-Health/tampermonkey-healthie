// Simulate extension storage and transport; telemetry itself comes from careplan.js.
const extensionStorage = new Map();
window.__datadogLogs = [];
window.GM_getValue = (key, fallback) => extensionStorage.get(key) ?? fallback;
window.GM_setValue = (key, value) => extensionStorage.set(key, value);
window.GM_xmlhttpRequest = (options) => {
  window.__datadogLogs.push(...JSON.parse(options.data));
  options.onload({ status: 202 });
};
