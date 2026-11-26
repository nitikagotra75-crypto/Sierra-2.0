import { apiBase } from "../lib/settings";
import { getToken } from "../lib/session";

async function req(path, opts) {
  const token = getToken();
  const res = await fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts && opts.headers) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    throw Object.assign(new Error(msg || `Request failed: ${res.status}`), { status: res.status, body });
  }
  if (res.status === 204) return null;
  return res.json();
}

const post = (path, data) => req(path, { method: "POST", body: JSON.stringify(data) });
const put = (path, data) => req(path, { method: "PUT", body: JSON.stringify(data) });

// Authenticated file download (the token is a header, so a plain <a href> cannot be used).
async function downloadBlob(path, fallbackName) {
  const token = getToken();
  const res = await fetch(`${apiBase()}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const cd = res.headers.get("content-disposition") || "";
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const api = {
  health: () => req("/health"),
  capabilities: () => req("/api/system/capabilities"),
  listStacks: () => req("/api/projects/stacks"),
  listProjects: () => req("/api/projects"),
  createProject: (data) => post("/api/projects", data),
  getProject: (id) => req(`/api/projects/${id}`),
  generate: (id) => req(`/api/projects/${id}/generate`, { method: "POST" }),
  listFiles: (id) => req(`/api/projects/${id}/files`),
  getFile: (id, path) => req(`/api/projects/${id}/files/${path}`),
  getSchema: (id) => req(`/api/projects/${id}/schema`),
  getTestResults: (id) => req(`/api/projects/${id}/test-results`),
  getStatus: (id) => req(`/api/projects/${id}/status`),
  listRecentRuns: () => req("/api/runs"),
  design: (data) => post("/api/design", data),
  designInfra: (data) => post("/api/design/infra", data),
  eventsUrl: (id) => `${apiBase()}/api/projects/${id}/events`,
  register: (email, password) => post("/api/auth/register", { email, password }),
  login: (email, password) => post("/api/auth/login", { email, password }),
  me: () => req("/api/auth/me"),
  listDiagrams: (projectId) => req(`/api/diagrams${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  createDiagram: (data) => post("/api/diagrams", data),
  getDiagram: (id) => req(`/api/diagrams/${id}`),
  saveDiagram: (id, data) => put(`/api/diagrams/${id}`, data),
  deleteDiagram: (id) => req(`/api/diagrams/${id}`, { method: "DELETE" }),
  diagramVersions: (id) => req(`/api/diagrams/${id}/versions`),
  restoreDiagram: (id, n) => post(`/api/diagrams/${id}/restore/${n}`, {}),
  downloadDiagram: (id, format) => downloadBlob(`/api/diagrams/${id}/export?format=${format}`, `diagram.${format}`),
  downloadUrl: (id) => `${apiBase()}/api/projects/${id}/download`,
};
