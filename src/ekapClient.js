const axios = require("axios");
const defaultSearchPayload = require("./defaultSearchPayload");

class EkapClient {
  constructor({ listUrl, detailUrl, timeout }) {
    this.listUrl = listUrl;
    this.detailUrl = detailUrl;
    this.http = axios.create({
      timeout,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
      },
    });
  }

  async fetchList({ skip, take }) {
    const payload = {
      ...defaultSearchPayload,
      paginationSkip: skip,
      paginationTake: take,
    };

    const response = await this.http.post(this.listUrl, payload);
    return response.data || {};
  }

  async fetchDetail({ ihaleId }) {
    const response = await this.http.post(this.detailUrl, { ihaleId });
    return response.data || {};
  }
}

module.exports = EkapClient;
