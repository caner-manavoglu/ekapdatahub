const axios = require("axios");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const defaultSearchPayload = require("./defaultSearchPayload");

class EkapClient {
  constructor({
    listUrl,
    detailUrl,
    timeout,
    keepAlive = true,
    maxSockets = 32,
    maxFreeSockets = 8,
    keepAliveMs = 1_000,
    conditionalRequests = true,
    conditionalCacheTtlMs = 6 * 60 * 60 * 1000,
    conditionalCacheSize = 2_000,
    responseCacheEnabled = true,
    responseCacheTtlMs = 30_000,
    responseCacheSize = 2_000,
  }) {
    this.listUrl = listUrl;
    this.detailUrl = detailUrl;
    this.httpAgent = keepAlive
      ? new http.Agent({
          keepAlive: true,
          keepAliveMsecs: keepAliveMs,
          maxSockets,
          maxFreeSockets,
        })
      : undefined;
    this.httpsAgent = keepAlive
      ? new https.Agent({
          keepAlive: true,
          keepAliveMsecs: keepAliveMs,
          maxSockets,
          maxFreeSockets,
        })
      : undefined;
    this.http = axios.create({
      timeout,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
    });
    this.conditionalEnabled = Boolean(conditionalRequests);
    this.conditionalCacheTtlMs = Math.max(10_000, Number(conditionalCacheTtlMs) || 21_600_000);
    this.conditionalCacheSize = Math.max(10, Number(conditionalCacheSize) || 2_000);
    this.conditionalCache = new Map();
    this.conditionalStats = {
      enabled: this.conditionalEnabled,
      requests: 0,
      validatorsUsed: 0,
      validatorsStored: 0,
      notModified: 0,
      cacheHits: 0,
      fallbackAfter304: 0,
    };
    this.responseCacheEnabled = Boolean(responseCacheEnabled);
    this.responseCacheTtlMs = Math.max(1_000, Number(responseCacheTtlMs) || 30_000);
    this.responseCacheSize = Math.max(10, Number(responseCacheSize) || 2_000);
    this.responseCache = new Map();
    this.responseCacheStats = {
      enabled: this.responseCacheEnabled,
      hits: 0,
      writes: 0,
    };
    this.customRequestHeadersEnabled = String(process.env.EKAP_CUSTOM_REQUEST_HEADERS || "auto")
      .trim()
      .toLowerCase() !== "off";
    this.customRequestHeadersTtlMs = Math.max(
      60_000,
      Number(process.env.EKAP_CUSTOM_REQUEST_HEADERS_TTL_MS) || 5 * 60 * 1000,
    );
    this.customRequestSession = null;
    this.customRequestSessionPromise = null;
    this.playwrightModule = null;
  }

  isEkapV2Request(url) {
    const text = String(url || "");
    return text.includes("ekapv2.kik.gov.tr");
  }

  shouldRetryWithFreshCustomHeaders(error) {
    const status = Number(error?.response?.status || 0);
    if (status === 401 || status === 403 || status === 500) {
      return true;
    }
    const message = String(error?.response?.data || error?.message || "")
      .trim()
      .toLocaleLowerCase("tr-TR");
    return (
      message.includes("iv eksik") ||
      message.includes("istek zaman aşımına uğradı") ||
      message.includes("istek zaman asimina ugradi")
    );
  }

  getCookieHeaderFromPlaywrightCookies(cookies) {
    const rows = Array.isArray(cookies) ? cookies : [];
    return rows
      .filter((cookie) => cookie && cookie.name && cookie.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  resolvePlaywrightModule() {
    if (this.playwrightModule) {
      return this.playwrightModule;
    }
    try {
      // Prefer local dependency when available.
      this.playwrightModule = require("playwright");
      return this.playwrightModule;
    } catch (_) {
      const fallback = path.resolve(__dirname, "../ekap-v3/node_modules/playwright");
      this.playwrightModule = require(fallback);
      return this.playwrightModule;
    }
  }

  async bootstrapCustomRequestSession() {
    const { chromium } = this.resolvePlaywrightModule();
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    try {
      const context = await browser.newContext({
        locale: "tr-TR",
      });
      const page = await context.newPage();
      const targetUrl = "https://ekapv2.kik.gov.tr/ekap/search";
      const targetApiPath = "/b_ihalearama/api/Ihale/GetListByParameters";

      const request = await new Promise((resolve, reject) => {
        let timeoutHandle = null;
        const onRequest = (candidate) => {
          if (candidate.method() !== "POST" || !candidate.url().includes(targetApiPath)) {
            return;
          }
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          page.off("request", onRequest);
          resolve(candidate);
        };

        page.on("request", onRequest);
        timeoutHandle = setTimeout(() => {
          page.off("request", onRequest);
          reject(new Error("EKAP list isteği beklenirken zaman aşımı oluştu."));
        }, 45_000);

        void page
          .goto(targetUrl, { waitUntil: "networkidle", timeout: 60_000 })
          .catch((error) => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
            page.off("request", onRequest);
            reject(error);
          });
      });
      const requestHeaders = request.headers();

      const allowedHeaderKeys = [
        "x-custom-request-guid",
        "x-custom-request-r8id",
        "x-custom-request-siv",
        "x-custom-request-ts",
        "api-version",
        "accept-language",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "user-agent",
      ];
      const headers = {
        Origin: "https://ekapv2.kik.gov.tr",
        Referer: targetUrl,
      };
      for (const key of allowedHeaderKeys) {
        const value = String(requestHeaders?.[key] || "").trim();
        if (!value) continue;
        headers[key] = value;
      }

      const cookies = await context.cookies("https://ekapv2.kik.gov.tr");
      const cookieHeader = this.getCookieHeaderFromPlaywrightCookies(cookies);
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      const requiredHeaders = [
        "x-custom-request-guid",
        "x-custom-request-r8id",
        "x-custom-request-siv",
        "x-custom-request-ts",
      ];
      const missing = requiredHeaders.filter((key) => !headers[key]);
      if (missing.length > 0) {
        throw new Error(`EKAP custom headers bulunamadi: ${missing.join(", ")}`);
      }

      return {
        headers,
        expiresAt: Date.now() + this.customRequestHeadersTtlMs,
      };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async ensureCustomRequestSession(forceRefresh = false) {
    if (!this.customRequestHeadersEnabled) {
      return null;
    }
    if (!forceRefresh && this.customRequestSession && this.customRequestSession.expiresAt > Date.now()) {
      return this.customRequestSession;
    }
    if (!forceRefresh && this.customRequestSessionPromise) {
      return this.customRequestSessionPromise;
    }

    const loader = (async () => {
      const session = await this.bootstrapCustomRequestSession();
      this.customRequestSession = session;
      return session;
    })();

    this.customRequestSessionPromise = loader;
    try {
      return await loader;
    } finally {
      if (this.customRequestSessionPromise === loader) {
        this.customRequestSessionPromise = null;
      }
    }
  }

  async postJsonWithPossibleCustomHeaders(url, body, conditionalHeaders, forceRefreshCustomHeaders = false) {
    const headers = {
      ...(conditionalHeaders || {}),
    };
    if (this.customRequestHeadersEnabled && this.isEkapV2Request(url)) {
      const session = await this.ensureCustomRequestSession(forceRefreshCustomHeaders);
      if (session?.headers) {
        Object.assign(headers, session.headers);
      }
    }

    return this.http.post(url, body, {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    });
  }

  buildConditionalKey(url, payload) {
    const raw = JSON.stringify(payload || {});
    const hash = crypto.createHash("sha1").update(raw).digest("hex");
    return `${url}::${hash}`;
  }

  getConditionalCacheEntry(key) {
    if (!this.conditionalEnabled) {
      return null;
    }
    const entry = this.conditionalCache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.conditionalCache.delete(key);
      return null;
    }
    return entry;
  }

  setConditionalCacheEntry(key, entry) {
    if (!this.conditionalEnabled || !entry) {
      return;
    }
    if (this.conditionalCache.has(key)) {
      this.conditionalCache.delete(key);
    }
    this.conditionalCache.set(key, entry);

    while (this.conditionalCache.size > this.conditionalCacheSize) {
      const oldestKey = this.conditionalCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.conditionalCache.delete(oldestKey);
    }
  }

  getResponseCacheEntry(key) {
    if (!this.responseCacheEnabled) {
      return null;
    }
    const entry = this.responseCache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.responseCache.delete(key);
      return null;
    }
    return entry;
  }

  setResponseCacheEntry(key, data) {
    if (!this.responseCacheEnabled) {
      return;
    }
    const entry = {
      data,
      expiresAt: Date.now() + this.responseCacheTtlMs,
    };
    if (this.responseCache.has(key)) {
      this.responseCache.delete(key);
    }
    this.responseCache.set(key, entry);
    this.responseCacheStats.writes += 1;

    while (this.responseCache.size > this.responseCacheSize) {
      const oldestKey = this.responseCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.responseCache.delete(oldestKey);
    }
  }

  pruneConditionalCache() {
    if (!this.conditionalEnabled || this.conditionalCache.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [key, value] of this.conditionalCache.entries()) {
      if (!value || value.expiresAt <= now) {
        this.conditionalCache.delete(key);
      }
    }
  }

  pruneResponseCache() {
    if (!this.responseCacheEnabled || this.responseCache.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [key, value] of this.responseCache.entries()) {
      if (!value || value.expiresAt <= now) {
        this.responseCache.delete(key);
      }
    }
  }

  updateConditionalCacheFromResponse(key, response, data) {
    if (!this.conditionalEnabled) {
      return;
    }

    const etag = String(response?.headers?.etag || "").trim();
    const lastModified = String(response?.headers?.["last-modified"] || "").trim();
    if (!etag && !lastModified) {
      return;
    }

    const existing = this.conditionalCache.get(key);
    if (!existing || existing.etag !== etag || existing.lastModified !== lastModified) {
      this.conditionalStats.validatorsStored += 1;
    }

    this.setConditionalCacheEntry(key, {
      etag: etag || null,
      lastModified: lastModified || null,
      data,
      expiresAt: Date.now() + this.conditionalCacheTtlMs,
    });
  }

  getConditionalStats() {
    return {
      ...this.conditionalStats,
      cacheSize: this.conditionalCache.size,
    };
  }

  getResponseCacheStats() {
    return {
      ...this.responseCacheStats,
      cacheSize: this.responseCache.size,
    };
  }

  async requestJson(url, payload) {
    const body = payload && typeof payload === "object" ? payload : {};
    const key = this.buildConditionalKey(url, body);
    this.pruneConditionalCache();
    this.pruneResponseCache();

    const responseCacheEntry = this.getResponseCacheEntry(key);
    if (responseCacheEntry && responseCacheEntry.data !== undefined) {
      this.responseCacheStats.hits += 1;
      this.setResponseCacheEntry(key, responseCacheEntry.data);
      return {
        data: responseCacheEntry.data,
        conditional: {
          notModified: false,
          cacheHit: false,
          usedValidator: false,
        },
        responseCache: {
          hit: true,
        },
      };
    }

    const cacheEntry = this.getConditionalCacheEntry(key);
    const conditionalHeaders = {};
    if (cacheEntry?.etag) {
      conditionalHeaders["If-None-Match"] = cacheEntry.etag;
    }
    if (cacheEntry?.lastModified) {
      conditionalHeaders["If-Modified-Since"] = cacheEntry.lastModified;
    }
    const hasConditionalHeaders = Object.keys(conditionalHeaders).length > 0;

    this.conditionalStats.requests += 1;
    if (hasConditionalHeaders) {
      this.conditionalStats.validatorsUsed += 1;
    }

    let response;
    try {
      response = await this.postJsonWithPossibleCustomHeaders(
        url,
        body,
        hasConditionalHeaders ? conditionalHeaders : undefined,
        false,
      );
    } catch (error) {
      if (this.customRequestHeadersEnabled && this.isEkapV2Request(url) && this.shouldRetryWithFreshCustomHeaders(error)) {
        response = await this.postJsonWithPossibleCustomHeaders(
          url,
          body,
          hasConditionalHeaders ? conditionalHeaders : undefined,
          true,
        );
      } else {
        throw error;
      }
    }

    if (response.status === 304) {
      if (cacheEntry && cacheEntry.data !== undefined) {
        this.conditionalStats.notModified += 1;
        this.conditionalStats.cacheHits += 1;
        this.setConditionalCacheEntry(key, {
          ...cacheEntry,
          expiresAt: Date.now() + this.conditionalCacheTtlMs,
        });
        return {
          data: cacheEntry.data,
          conditional: {
            notModified: true,
            cacheHit: true,
            usedValidator: hasConditionalHeaders,
          },
          responseCache: {
            hit: false,
          },
        };
      }

      // 304 response without local cache should not break the flow.
      this.conditionalStats.fallbackAfter304 += 1;
      const fallbackResponse = await this.postJsonWithPossibleCustomHeaders(url, body, undefined, false);
      const fallbackData = fallbackResponse.data || {};
      this.updateConditionalCacheFromResponse(key, fallbackResponse, fallbackData);
      this.setResponseCacheEntry(key, fallbackData);
      return {
        data: fallbackData,
        conditional: {
          notModified: false,
          cacheHit: false,
          usedValidator: hasConditionalHeaders,
          fallbackAfter304: true,
        },
        responseCache: {
          hit: false,
        },
      };
    }

    const data = response.data || {};
    this.updateConditionalCacheFromResponse(key, response, data);
    this.setResponseCacheEntry(key, data);
    return {
      data,
      conditional: {
        notModified: false,
        cacheHit: false,
        usedValidator: hasConditionalHeaders,
      },
      responseCache: {
        hit: false,
      },
    };
  }

  async fetchList({ skip, take }) {
    const payload = {
      ...defaultSearchPayload,
      paginationSkip: skip,
      paginationTake: take,
    };

    const result = await this.requestJson(this.listUrl, payload);
    const data = result.data && typeof result.data === "object" ? result.data : {};
    return {
      ...data,
      _conditional: result.conditional,
      _responseCache: result.responseCache,
    };
  }

  async fetchDetail({ ihaleId }) {
    const result = await this.requestJson(this.detailUrl, { ihaleId });
    const data = result.data && typeof result.data === "object" ? result.data : {};
    return {
      ...data,
      _conditional: result.conditional,
      _responseCache: result.responseCache,
    };
  }

  close() {
    this.httpAgent?.destroy?.();
    this.httpsAgent?.destroy?.();
    this.conditionalCache.clear();
    this.responseCache.clear();
  }
}

module.exports = EkapClient;
