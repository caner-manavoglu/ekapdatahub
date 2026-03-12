const axios = require("axios");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
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

    const response = await this.http.post(url, body, {
      headers: hasConditionalHeaders ? conditionalHeaders : undefined,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    });

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
      const fallbackResponse = await this.http.post(url, body);
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
