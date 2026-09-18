// Tier 1: the wire to Microsoft -- the identity platform for tokens, Graph for data.
//
// This module knows URLs, form encodings and status codes. It does not know what a user
// is, which account a token belongs to, or where a token is stored: those are
// orchestration/microsoft.js. Like database.js and storage.js, an error thrown from here
// means the connection or the remote service failed, not that the caller asked for
// something wrong -- GraphError carries the status and Microsoft's own error code so the
// tier above can decide which of those it was.
//
// Delegated OAuth 2.0 authorization-code flow, hand-written over fetch. @azure/msal-node
// was in package.json and would do the same three calls, but it owns the tokens: its cache
// is an opaque blob per account that it expects to persist and reload wholesale, which
// fights a schema holding one encrypted refresh token per row that a later import job
// reads. Three POSTs against a documented endpoint are shorter than the adapter would be.
//
// Tokens rotate. Every successful refresh returns a NEW refresh token and the old one is
// eventually invalidated, so whoever calls refreshTokens() must store what comes back. The
// primitive says so here because it is the one fact about this API that silently breaks
// an implementation that ignores it -- weeks later, when the old token stops working.
//
// Scopes are the smallest set that reads a workbook someone shares with the signed-in
// account: `openid profile email` is what makes the token endpoint return an id_token at
// all -- without `openid` there is no identity to record, whatever else was granted --
// `offline_access` is what yields a refresh token, `User.Read` the Graph identity,
// `Files.Read.All` the files, including SharePoint document libraries the person can
// reach. `Sites.Read.All` is not requested: it is not supported for personal accounts and
// a `common` tenant admits those.
//
// The app registration -- `{ tenantId, clientId, clientSecret }` -- is an argument to
// every token call, not read from the environment here. Where it comes from (the
// microsoft_app row, or MS_* in .env as the fallback) is orchestration's decision; this
// module only knows how to use one.

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

export const SCOPES = "openid profile email offline_access User.Read Files.Read.All";

/** The identity platform's error, or Graph's, with what the caller needs to classify it. */
export class GraphError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, code?: string | null, retryAfter?: number | null }} details
   */
  constructor(message, { status, code = null, retryAfter = null }) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Derived from API_DOMAIN so the two cannot disagree; the registration must list it. */
export function redirectUri() {
  const base = (process.env.API_DOMAIN || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/api/microsoft/callback`;
}

/**
 * Where to send the browser to sign in and consent.
 *
 * @param {{ tenantId: string, clientId: string }} app The registration.
 * @param {{ state: string }} options `state` comes back untouched on the callback.
 * @returns {string}
 */
export function authorizeUrl(app, { state }) {
  const params = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: SCOPES,
    state,
    // Always offer the account picker: the person connecting may hold several accounts,
    // and the one their browser is signed into is not necessarily the one with the files.
    prompt: "select_account",
  });
  return `${AUTHORITY}/${app.tenantId}/oauth2/v2.0/authorize?${params}`;
}

/**
 * Trades the callback's authorization code for tokens.
 *
 * @param {{ tenantId: string, clientId: string, clientSecret: string }} app
 * @param {string} code
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number,
 *   idToken: string, scope: string }>}
 * @throws {GraphError} with the identity platform's `error` as `code`.
 */
export function exchangeCode(app, code) {
  return tokenRequest(app, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
}

/**
 * A fresh access token from a refresh token. The result carries a NEW refresh token;
 * persist it, the one passed in is now on borrowed time.
 *
 * @param {{ tenantId: string, clientId: string, clientSecret: string }} app
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number,
 *   idToken: string | null, scope: string }>}
 * @throws {GraphError} `code === 'invalid_grant'` means the grant is gone for good --
 *   revoked, expired, or the password changed -- and the account must be reconnected.
 */
export function refreshTokens(app, refreshToken) {
  return tokenRequest(app, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function tokenRequest(app, fields) {
  const body = new URLSearchParams({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    scope: SCOPES,
    ...fields,
  });

  const response = await fetch(`${AUTHORITY}/${app.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GraphError(
      data?.error_description || `Microsoft token endpoint answered ${response.status}.`,
      { status: response.status, code: data?.error ?? null },
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in),
    idToken: data.id_token ?? null,
    scope: data.scope ?? "",
  };
}

/**
 * GET against Graph as the given access token. A paged collection is followed to the end
 * through `@odata.nextLink` and returned as one `value` array; a single resource comes
 * back as-is. One 429 is honoured by waiting `Retry-After`; a second is thrown.
 *
 * @param {string} accessToken
 * @param {string} path Relative to the v1.0 root, e.g. `/me/drive`.
 * @returns {Promise<object>}
 * @throws {GraphError} with Graph's `error.code` (`itemNotFound`,
 *   `InvalidAuthenticationToken`, ...) as `code`.
 */
export async function graphGet(accessToken, path) {
  let url = `${GRAPH}${path}`;
  let merged = null;
  let retried = false;

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 429 && !retried) {
      retried = true;
      const seconds = Number(response.headers.get("retry-after")) || 1;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new GraphError(
        data?.error?.message || `Microsoft Graph answered ${response.status}.`,
        {
          status: response.status,
          code: data?.error?.code ?? null,
          retryAfter: Number(response.headers.get("retry-after")) || null,
        },
      );
    }

    if (!Array.isArray(data?.value)) return data;

    merged = merged ? { ...merged, value: merged.value.concat(data.value) } : data;
    url = data["@odata.nextLink"] ?? null;
  }

  delete merged["@odata.nextLink"];
  return merged;
}
