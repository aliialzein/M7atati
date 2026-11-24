const base = (import.meta.env?.VITE_API_ORIGIN || "").replace(/\/+$/, "");
const safeMethods = new Set(["GET", "HEAD"]);
let refreshing;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = "GET", body, signal, binary } = {}) {
  const headers = { Accept: binary ? "*/*" : "application/json" };
  if (!safeMethods.has(method)) headers["X-CSRF-Protection"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      signal,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "Could not reach the server. Check the connection and try again.",
    );
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      payload?.message || `Request failed (${response.status}).`,
    );
  }
  if (response.status === 204) return undefined;
  return binary ? response.blob() : response.json();
}

function refresh() {
  if (!refreshing) {
    async function renew() {
      // Another tab may have rotated the cookie while this tab waited.
      const session = await request("/auth/me").catch((error) => {
        if (error.status !== 401) throw error;
      });
      return session || request("/auth/refresh", { method: "POST" });
    }
    refreshing = (
      navigator.locks
        ? navigator.locks.request("smartstation-session", renew)
        : renew()
    ).finally(() => {
      refreshing = undefined;
    });
  }
  return refreshing;
}

export async function api(path, options = {}) {
  try {
    return await request(path, options);
  } catch (error) {
    if (error.status !== 401 || options.public) throw error;
    try {
      const { user } = await refresh();
      window.dispatchEvent(
        new CustomEvent("smartstation-session", { detail: user }),
      );
    } catch (refreshError) {
      if (refreshError.status === 401) {
        window.dispatchEvent(
          new CustomEvent("smartstation-session", { detail: null }),
        );
      }
      throw refreshError;
    }
    return request(path, options);
  }
}

export async function restoreSession() {
  try {
    return (await request("/auth/me")).user;
  } catch (error) {
    if (error.status !== 401) throw error;
  }
  try {
    return (await refresh()).user;
  } catch (error) {
    if (error.status !== 401) throw error;
    return null;
  }
}

export async function signOut() {
  if (refreshing) await refreshing.catch(() => {});
  await request("/auth/logout", { method: "POST" });
}

export function query(path, values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value != null) params.set(key, String(value));
  }
  return params.size ? `${path}?${params}` : path;
}
