const loginEl = {
  form: document.getElementById("loginForm"),
  username: document.getElementById("loginUsername"),
  password: document.getElementById("loginPassword"),
  submitButton: document.getElementById("loginSubmitButton"),
  status: document.getElementById("loginStatus"),
};

function parseResponsePayload(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

function getNextTarget() {
  const params = new URLSearchParams(window.location.search || "");
  const raw = params.get("next");
  const fallback = "/";
  if (window.EkapAuth?.sanitizeNextTarget) {
    return window.EkapAuth.sanitizeNextTarget(raw || fallback);
  }

  const value = String(raw || fallback).trim();
  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  return value;
}

function setStatus(message, type = "neutral") {
  loginEl.status.textContent = message;
  loginEl.status.style.borderColor = "";
  loginEl.status.style.background = "";
  loginEl.status.style.color = "";

  if (type === "success") {
    loginEl.status.style.borderColor = "rgba(71, 211, 190, 0.65)";
    loginEl.status.style.background = "rgba(71, 211, 190, 0.16)";
    loginEl.status.style.color = "#fff";
  } else if (type === "error") {
    loginEl.status.style.borderColor = "rgba(255, 107, 107, 0.65)";
    loginEl.status.style.background = "rgba(255, 107, 107, 0.16)";
    loginEl.status.style.color = "#fff";
  }
}

async function postLogin(payload) {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });

  const text = await response.text();
  const body = parseResponsePayload(text);
  if (!response.ok) {
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }

  return body;
}

async function runLogin(event) {
  event.preventDefault();
  const username = String(loginEl.username.value || "").trim();
  const password = String(loginEl.password.value || "");
  if (!username || !password) {
    setStatus("Kullanıcı adı ve şifre zorunlu.", "error");
    return;
  }

  loginEl.submitButton.disabled = true;
  setStatus("Giriş yapılıyor...");
  try {
    await postLogin({ username, password });
    setStatus("Giriş başarılı. Yönlendiriliyor...", "success");
    window.location.assign(getNextTarget());
  } catch (error) {
    setStatus(error?.message || "Giriş başarısız.", "error");
  } finally {
    loginEl.submitButton.disabled = false;
  }
}

loginEl.form.addEventListener("submit", (event) => {
  void runLogin(event);
});

(async () => {
  if (window.EkapAuth?.ready) {
    await window.EkapAuth.ready;
  }

  if (window.EkapAuth?.isAuthEnabled && !window.EkapAuth.isAuthEnabled()) {
    setStatus("Kimlik doğrulama kapalı. Ana sayfaya yönlendiriliyorsunuz.", "success");
    window.setTimeout(() => {
      window.location.assign("/");
    }, 500);
    return;
  }

  if (window.EkapAuth?.getUser && window.EkapAuth.getUser()) {
    window.location.assign(getNextTarget());
    return;
  }

  loginEl.username.focus();
})();
