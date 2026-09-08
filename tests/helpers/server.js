// Boots a real API on a real socket for a test file, and tears it down again.
//
// Requests go over HTTP rather than through an in-process shim. That is the point: it is
// the only way the suite exercises helmet, cors and express.json() as they actually run,
// and those three are where several of the behaviours being asserted live -- the 400 for
// malformed JSON and the 413 for an oversized body are the body parser's, not ours.
import Api from '../../src/api.js';
import { openStore, closeStore } from '../../src/access/primitives/database.js';
import { useTestDatabase } from './env.js';

// morgan takes a format function as readily as a format name, and skips the line entirely
// when the function returns a falsy value. That is the whole silencing mechanism -- there
// is no 'silent' format to name, and the alternative would have been a source change to
// api.js purely for the benefit of the tests.
const SILENT = () => null;

// api.start() announces the bound port on stdout, which is right for main.js and pure
// noise once per test file. Muted here rather than made conditional in api.js: the tests
// should bend around the application, not the other way round.
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

// Open the pool and start the server. api.js deliberately does not open the pool -- only
// main.js does -- so a suite that forgets this gets a 500 from every database-backed route
// and a 503 from /api/health, which is a confusing way to learn it.
export async function startServer() {
  useTestDatabase();
  openStore();

  const api = new Api({ port: 0, logFormat: SILENT });
  await quietly(() => api.start());

  return new Server(api);
}

class Server {
  constructor(api) {
    this.api = api;
    this.base = `http://${api.host}:${api.port}`;
  }

  // One shape for every call: { status, body, headers }. The body is parsed when it is
  // JSON and returned as text when it is not, because a few of the error paths are worth
  // asserting precisely because they do NOT come back as JSON.
  async request(method, path, { body, token, headers = {}, raw } = {}) {
    const init = { method, headers: { ...headers } };

    if (token) init.headers.authorization = `Bearer ${token}`;

    // `raw` sends a string through untouched, for the malformed-JSON case: JSON.stringify
    // would repair exactly the damage that test is trying to inflict.
    if (raw !== undefined) {
      init.headers['content-type'] ??= 'application/json';
      init.body = raw;
    } else if (body !== undefined) {
      init.headers['content-type'] ??= 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${this.base}${path}`, init);
    const text = await res.text();

    let parsed;
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

  // The areas and roles routers were the first to use anything but GET and POST. Thin
  // wrappers over request() rather than callers passing the verb themselves, so a test
  // reads as the HTTP it performs.
  put(path, options) {
    return this.request('PUT', path, options);
  }

  patch(path, options) {
    return this.request('PATCH', path, options);
  }

  // `delete` is a reserved word as a bare identifier but legal as a method name, and using
  // the verb's own name is worth more than avoiding the surprise.
  delete(path, options) {
    return this.request('DELETE', path, options);
  }

  async close() {
    await this.api.stop();
    await closeStore();
  }
}

// The degraded-health file needs a server whose pool was never opened, so it cannot use
// startServer(). Exported separately rather than as a flag, because "start the API in a
// state main.js would never leave it in" deserves to be spelled out at the call site.
export async function startServerWithoutDatabase() {
  const api = new Api({ port: 0, logFormat: SILENT });
  await quietly(() => api.start());
  return new Server(api);
}
