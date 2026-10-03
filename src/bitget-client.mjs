import crypto from 'node:crypto';

export class BitgetApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BitgetApiError';
    Object.assign(this, details);
  }
}

function sortedQuery(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
    .join('&');
}

export function normalizeSymbol(symbol) {
  return String(symbol || '').replace(/[/\s_-]/g, '').toUpperCase();
}

export class BitgetClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://api.bitget.com').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.secretKey = options.secretKey || '';
    this.passphrase = options.passphrase || '';
    this.locale = options.locale || 'zh-CN';
    this.channelCode = options.channelCode || '';
  }

  get isConfigured() {
    return Boolean(this.apiKey && this.secretKey && this.passphrase);
  }

  setCredentials({ apiKey = '', secretKey = '', passphrase = '' } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.secretKey = String(secretKey || '').trim();
    this.passphrase = String(passphrase || '').trim();
  }

  sign(timestamp, method, requestPath, queryString, bodyString) {
    const preHash = timestamp + method.toUpperCase() + requestPath +
      (queryString ? '?' + queryString : '') + (bodyString || '');
    return crypto.createHmac('sha256', this.secretKey).update(preHash, 'utf8').digest('base64');
  }

  async request(method, requestPath, { query = {}, body = null, privateRequest = false } = {}) {
    const queryString = sortedQuery(query);
    const url = this.baseUrl + requestPath + (queryString ? '?' + queryString : '');
    const bodyString = body === null || body === undefined ? '' : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', locale: this.locale };

    if (privateRequest) {
      if (!this.isConfigured) {
        throw new BitgetApiError('Bitget API 尚未配置', { code: 'CONFIG_MISSING', status: 503 });
      }
      const timestamp = String(Date.now());
      headers['ACCESS-KEY'] = this.apiKey;
      headers['ACCESS-SIGN'] = this.sign(timestamp, method, requestPath, queryString, bodyString);
      headers['ACCESS-PASSPHRASE'] = this.passphrase;
      headers['ACCESS-TIMESTAMP'] = timestamp;
      if (this.channelCode) headers['X-CHANNEL-API-CODE'] = this.channelCode;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: bodyString || undefined,
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new BitgetApiError('Bitget 返回了无法解析的响应', { status: response.status });
    }
    if (!response.ok || payload.code !== '00000') {
      throw new BitgetApiError(payload.msg || ('Bitget HTTP ' + response.status), {
        status: response.status,
        code: payload.code,
        raw: payload
      });
    }
    return payload;
  }

  async getSymbols(symbol) {
    const normalized = symbol ? normalizeSymbol(symbol) : undefined;
    try {
      const payload = await this.request('GET', '/api/v3/market/instruments', {
        query: { category: 'SPOT', ...(normalized ? { symbol: normalized } : {}) }
      });
      return payload.data || [];
    } catch (error) {
      // Keep compatibility with accounts whose API gateway still exposes the classic v2 endpoint.
      const payload = await this.request('GET', '/api/v2/spot/public/symbols', {
        query: normalized ? { symbol: normalized } : {}
      });
      return payload.data || [];
    }
  }

  async getTickers(symbol) {
    const payload = await this.request('GET', '/api/v2/spot/market/tickers', {
      query: symbol ? { symbol: normalizeSymbol(symbol) } : {}
    });
    return payload.data || [];
  }

  async getAssets(coin) {
    try {
      const payload = await this.request('GET', '/api/v3/account/assets', {
        query: coin ? { coin: coin.toUpperCase() } : {},
        privateRequest: true
      });
      return payload.data || [];
    } catch (error) {
      const payload = await this.request('GET', '/api/v2/spot/account/assets', {
        query: coin ? { coin: coin.toUpperCase() } : {},
        privateRequest: true
      });
      return payload.data || [];
    }
  }

  async placeMarketBuy({ symbol, quoteAmount, clientOid }) {
    try {
      const payload = await this.request('POST', '/api/v3/trade/place-order', {
        privateRequest: true,
        body: {
          category: 'SPOT',
          symbol: normalizeSymbol(symbol),
          side: 'buy',
          orderType: 'market',
          qty: String(quoteAmount),
          clientOid
        }
      });
      return payload.data;
    } catch (error) {
      if (!(error instanceof BitgetApiError) || ['40010', '40725', '45001'].includes(String(error.code)) || error.status >= 500) {
        throw new BitgetApiError('下单结果暂未确认，请先在 Bitget 按订单标识 ' + clientOid + ' 查询，避免重复投入', {
          status: 502, code: 'ORDER_RESULT_UNKNOWN', uncertain: true
        });
      }
      const payload = await this.request('POST', '/api/v2/spot/trade/place-order', {
        privateRequest: true,
        body: {
          symbol: normalizeSymbol(symbol),
          side: 'buy',
          orderType: 'market',
          size: String(quoteAmount),
          clientOid
        }
      });
      return payload.data;
    }
  }

  async getOrderInfo({ orderId, clientOid }) {
    const payload = await this.request('GET', '/api/v2/spot/trade/orderInfo', {
      privateRequest: true,
      query: { orderId, clientOid }
    });
    return payload.data || [];
  }
}

