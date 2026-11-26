// Per-browser preferences. localStorage can throw (private mode, blocked storage), so every access is guarded.
const KEY = "sierra.settings.v1";
const DEFAULTS = { apiBase: "", defaultStack: "python-fastapi", defaultDatabase: "", defaultArchitecture: "monolith" };

export function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch { /* storage unavailable: settings last for this page view only */ }
  return next;
}

export function apiBase() {
  return (getSettings().apiBase || import.meta.env.VITE_API_BASE || "http://localhost:5001").replace(/\/+$/, "");
}
