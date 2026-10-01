// Boots a real API on a real socket for a test file, and tears it down again.
//
// Requests go over HTTP rather than through an in-process shim, so helmet, cors and
// express.json() run as they do in production -- the 400 for malformed JSON and the 413 for
// an oversized body are the body parser's, not ours.
import Api from '../../src/api.js';
import { openStore, closeStore } from '../../src/access/primitives/database.js';
import { useTestDatabase } from './env.js';

/**
 * Starts the API on a free port against the test database. api.js does not open the pool,
 * so this does; without it every route answers 500.
 *
 * @returns {Promise<Server>}
 */
export async function startServer() {
  useTestDatabase();
  openStore();
  return listen();
}

/** Starts the API with no pool open, for the degraded-health and docs files. */
export async function startServerWithoutDatabase() {
  return listen();
}

async function listen() {
  const api = new Api({ port: 0, logFormat: () => null });
  const log = console.log;
  console.log = () => {};
  try {
    await api.start();
  } finally {
    console.log = log;
  }
  return new Server(api);
}

class Server {
  constructor(api) {
    this.api = api;
    this.base = `http://${api.host}:${api.port}`;
  }

  /**
   * Sends a request and returns `{ status, body, text, headers }`. `body` is parsed JSON, or
   * null when the response is not JSON; `raw` sends a string as-is instead of `body`.
   */
  async request(method, path, { body, token, headers = {}, raw, redirect } = {}) {
    const init = { method, headers: { ...headers }, redirect };
    if (token) init.headers.authorization = `Bearer ${token}`;

    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    if (payload !== undefined) {
      init.headers['content-type'] ??= 'application/json';
      init.body = payload;
    }

    const res = await fetch(`${this.base}${path}`, init);
    const text = await res.text();

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    return { status: res.status, body: parsed, text, headers: res.headers };
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  post(path, options) {
    return this.request('POST', path, options);
  }

  put(path, options) {
    return this.request('PUT', path, options);
  }

  patch(path, options) {
    return this.request('PATCH', path, options);
  }

  delete(path, options) {
    return this.request('DELETE', path, options);
  }

  async close() {
    await this.api.stop();
    await closeStore();
  }
}
