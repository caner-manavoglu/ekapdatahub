const AUTH_LOGIN_PATH = "/login";

const authState = {
  authEnabled: false,
  user: null,
  csrfToken: "",
};

function isLoginPage() {
  const pathname = window.location.pathname;
  return pathname === "/login" || pathname === "/login.html";
}

function sanitizeNextTarget(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function buildCurrentTarget() {
  const path = `${window.location.pathname || "/"}${window.location.search || ""}`;
  return sanitizeNextTarget(path || "/");
}

function redirectToLogin(targetPath = buildCurrentTarget()) {
  if (isLoginPage()) {
    return;
  }

  const nextTarget = sanitizeNextTarget(targetPath || buildCurrentTarget());
  if (!nextTarget || nextTarget === "/") {
    window.location.assign(AUTH_LOGIN_PATH);
    return;
  }

  const params = new URLSearchParams();
  params.set("next", nextTarget);
  window.location.assign(`${AUTH_LOGIN_PATH}?${params.toString()}`);
}

function parseResponsePayload(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });
  const text = await response.text();
  const payload = parseResponsePayload(text);

  if (!response.ok) {
    const error = new Error(payload?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function applyAuthUi() {
  const logoutButtons = Array.from(document.querySelectorAll("[data-auth-logout]"));

  for (const button of logoutButtons) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.hidden = !(authState.authEnabled && authState.user);
    button.disabled = !(authState.authEnabled && authState.user);
  }
}

async function loadSession() {
  try {
    const payload = await fetchJson("/api/auth/me");
    const data = payload?.data || {};

    authState.authEnabled = Boolean(data.authEnabled);
    authState.user = data.user || null;
    authState.csrfToken = String(data.csrfToken || "");
    applyAuthUi();

    if (authState.authEnabled && !authState.user && !isLoginPage()) {
      redirectToLogin();
    }

    return authState;
  } catch (error) {
    if (error?.status === 401) {
      authState.authEnabled = true;
      authState.user = null;
      authState.csrfToken = "";
      applyAuthUi();
      if (!isLoginPage()) {
        redirectToLogin();
      }
      return authState;
    }

    console.error(error);
    if (!isLoginPage()) {
      redirectToLogin();
    }
    return authState;
  }
}

async function logout() {
  const headers =
    authState.authEnabled && authState.csrfToken
      ? {
          "x-csrf-token": authState.csrfToken,
        }
      : {};

  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers,
    });
  } catch (_) {
    // Ignore network errors during logout, redirect anyway.
  }

  authState.user = null;
  authState.csrfToken = "";
  applyAuthUi();
  window.location.assign(AUTH_LOGIN_PATH);
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const logoutTrigger = target.closest("[data-auth-logout]");
  if (!logoutTrigger) {
    return;
  }

  event.preventDefault();
  void logout();
});

const authReady = loadSession();

window.EkapAuth = {
  ready: authReady,
  isAuthEnabled() {
    return authState.authEnabled;
  },
  getUser() {
    return authState.user;
  },
  getCsrfToken() {
    return authState.csrfToken;
  },
  withCsrfHeaders(headers = {}) {
    if (authState.authEnabled && authState.csrfToken) {
      return {
        ...headers,
        "x-csrf-token": authState.csrfToken,
      };
    }
    return {
      ...headers,
    };
  },
  redirectToLogin,
  sanitizeNextTarget,
  logout,
};
