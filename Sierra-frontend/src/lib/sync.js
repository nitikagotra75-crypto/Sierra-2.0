// Turns an API error from the diagram endpoints into a user-facing sync status.
export function syncMessage(err) {
  if (err && err.status === 409) return { state: "conflict", text: "This diagram was changed elsewhere (another device or tab). Reload the server version or overwrite it with yours." };
  if (err && err.status === 401) return { state: "auth", text: "Your session expired. Sign in again." };
  if (err && err.status === 404) return { state: "error", text: "This diagram no longer exists on the server." };
  if (err && err.status === 422) return { state: "error", text: err.message };
  if (err instanceof TypeError) return { state: "offline", text: "Cannot reach the server. Your edits are kept in this browser." };
  return { state: "error", text: (err && err.message) || "Sync failed" };
}
