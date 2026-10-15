// Microsoft accounts that people connect so the spreadsheet import can read their workbooks
// (RF-MIG-01). accessTokenFor() is the only way to get a Graph token. People use their own
// accounts; admins can use anyone's.
import * as jose from "jose";

import query from "../resources/query.js";
import {
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  redirectUri,
  GraphError,
} from "../primitives/microsoftGraph.js";
import auth from "./auth.js";
import events from "../../utils/events.js";
import { seal, open } from "../../utils/crypto.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  cleanText,
  requireId,
} from "../../utils/validate.js";

/** Refresh this many seconds before the access token actually expires. */
const EXPIRY_MARGIN_S = 60;

class Microsoft {
  /** Access tokens by account id, for the hour Microsoft says they last. */
  #cache = new Map();

  /**
   * Where to send the browser so `userId` can connect an account. Microsoft redirects back to
   * the public callback with no session, so `state` carries a ten-minute token naming the user
   * (purpose `ms_connect`); without it a code could be attached to anyone.
   *
   * @param {number} userId
   * @returns {Promise<{ url: string }>}
   */
  async connectUrl(userId) {
    const app = await this.#app();
    const state = await auth.issueConnectState(userId);
    return { url: authorizeUrl(app, { state }) };
  }

  /**
   * Finishes a sign-in: verifies the state, trades the code, stores the grant. The
   * identity comes from the id_token's claims, decoded but not re-verified -- it arrived
   * over TLS straight from the token endpoint in the same response as the tokens, and a
   * forged one would have had to come from Microsoft itself.
   *
   * @param {{ code: string, state: string }} callback
   * @returns {Promise<object>} The account, shaped for the API.
   * @throws {ApiError} 401 on a bad state, 502 when Microsoft refuses the code.
   */
  async completeConnect({ code, state }) {
    const userId = await auth.verifyConnectState(state);
    if (typeof code !== "string" || code === "") {
      throw ApiError.badRequest("Microsoft returned no authorization code.");
    }

    let tokens;
    try {
      tokens = await exchangeCode(await this.#app(), code);
    } catch (err) {
      throw translateExchange(err);
    }

    const claims = tokens.idToken ? jose.decodeJwt(tokens.idToken) : {};
    if (!claims.oid || !claims.tid) {
      throw ApiError.badGateway("Microsoft returned no account identity.");
    }

    const row = await query.createMicrosoftAccount({
      userId,
      msObjectId: claims.oid,
      tenantId: claims.tid,
      email: claims.preferred_username ?? claims.email ?? null,
      displayName: claims.name ?? null,
      refreshTokenEnc: seal(tokens.refreshToken),
      scopes: tokens.scope,
    });

    this.#cache.set(row.id, {
      token: tokens.accessToken,
      expiresAt: Date.now() + (tokens.expiresIn - EXPIRY_MARGIN_S) * 1000,
    });

    await events.emit({
      action: "microsoft_account_connected",
      target: { table: "microsoft_accounts", id: row.id },
      after: row,
    });

    return shapeAccount(row);
  }

  /**
   * A working access token for the account, refreshed if need be. The only way to Graph.
   *
   * @param {number|string} accountId
   * @param {object} actor `req.user`; must own the account or be admin.
   * @returns {Promise<string>}
   * @throws {ApiError} 404 unknown or revoked, 403 not the actor's, 409 when the grant
   *   turns out to be gone and the account has just been marked revoked.
   */
  async accessTokenFor(accountId, actor) {
    const account = await this.#usable(accountId, actor);

    const cached = this.#cache.get(account.id);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    let tokens;
    try {
      tokens = await refreshTokens(await this.#app(), open(account.refresh_token_enc));
    } catch (err) {
      if (err instanceof GraphError && err.code === "invalid_grant") {
        await this.#markRevoked(account);
        throw ApiError.conflict(
          "Microsoft access to this account was revoked; connect it again.",
        );
      }
      throw translateGraph(err);
    }

    await query.updateMicrosoftRefreshToken(account.id, seal(tokens.refreshToken));
    this.#cache.set(account.id, {
      token: tokens.accessToken,
      expiresAt: Date.now() + (tokens.expiresIn - EXPIRY_MARGIN_S) * 1000,
    });

    return tokens.accessToken;
  }

  /**
   * The registration in force: the microsoft_app row, else MS_* from .env.
   *
   * @returns {Promise<{ tenantId: string, clientId: string, clientSecret: string }>}
   * @throws {ApiError} 503 when neither is set.
   */
  async #app() {
    const row = await query.getMicrosoftApp();
    if (row) {
      return {
        tenantId: row.tenant_id,
        clientId: row.client_id,
        clientSecret: open(row.client_secret_enc),
      };
    }

    const { MS_CLIENT_ID: clientId, MS_CLIENT_SECRET: clientSecret } = process.env;
    if (!clientId || !clientSecret) {
      throw ApiError.unavailable(
        "Microsoft sign-in is not configured: save the app registration in the settings screen, or set MS_CLIENT_ID and MS_CLIENT_SECRET in .env.",
      );
    }
    return { tenantId: process.env.MS_TENANT_ID || "common", clientId, clientSecret };
  }

  /**
   * What is configured, for the settings screen: never the secret, only whether there is
   * one, plus the redirect URI the Azure registration has to list.
   *
   * @returns {Promise<object>}
   */
  async getApp() {
    const row = await query.getMicrosoftApp();
    const env = Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

    return {
      source: row ? "database" : env ? "env" : null,
      tenantId: row ? row.tenant_id : env ? process.env.MS_TENANT_ID || "common" : null,
      clientId: row ? row.client_id : env ? process.env.MS_CLIENT_ID : null,
      hasSecret: Boolean(row) || env,
      redirectUri: redirectUri(),
      updatedAt: row?.updated_at ?? null,
      updatedByName: row?.updated_by_name ?? null,
    };
  }

  /**
   * Saves the registration. The secret may be omitted when one is already stored -- the
   * form never shows it, so re-saving the other fields must not require re-typing it.
   *
   * @param {{ tenantId?: string, clientId: string, clientSecret?: string }} input
   * @param {object} actor
   * @returns {Promise<object>} getApp()'s shape.
   * @throws {ApiError} 400 on a bad payload, or a missing secret with none stored.
   */
  async setApp({ tenantId, clientId, clientSecret }, actor) {
    const tenant = cleanText(tenantId) ?? "common";
    const client = cleanText(clientId);
    const secret = cleanText(clientSecret);

    if (!client || client.length > 64 || tenant.length > 64) {
      throw ApiError.badRequest("clientId is required (64 characters or fewer).");
    }
    if (!/^[A-Za-z0-9.-]+$/.test(tenant)) {
      throw ApiError.badRequest("tenantId must be 'common', 'organizations' or a tenant id.");
    }
    const before = await query.getMicrosoftApp();
    if (secret === null && !before) {
      throw ApiError.badRequest("clientSecret is required the first time.");
    }

    const row = await query.setMicrosoftApp({
      tenantId: tenant,
      clientId: client,
      clientSecretEnc: secret === null ? null : seal(secret),
      updatedBy: actor?.id ?? null,
    });

    await events.emit({
      action: before ? "record_updated" : "record_created",
      target: { table: "microsoft_app", id: row.id },
      before,
      after: row,
    });

    return this.getApp();
  }

  /**
   * Removes the stored registration, falling back to .env if it has one. Accounts already
   * connected keep their grants -- they were made to the registration, and if it is truly
   * gone their next refresh fails and marks them revoked.
   *
   * @throws {ApiError} 404 when nothing was stored.
   */
  async clearApp() {
    const row = await query.deleteMicrosoftApp();
    if (!row) throw ApiError.notFound("No app registration is stored.");

    await events.emit({
      action: "record_deleted",
      target: { table: "microsoft_app", id: row.id },
      before: row,
    });

    return this.getApp();
  }

  /**
   * The live account, checked for ownership. Shared with spreadsheets.js so registering a
   * book through someone else's account is refused the same way reading one is.
   *
   * @returns {Promise<object>} The shaped account.
   */
  async usableAccount(accountId, actor) {
    return shapeAccount(await this.#usable(accountId, actor));
  }

  async #usable(accountId, actor) {
    const account = await query.getMicrosoftAccount(requireId(accountId, "accountId"));
    if (!account || account.revoked_at !== null) {
      throw ApiError.notFound("Microsoft account not found.");
    }
    if (!mayUse(account, actor)) {
      throw ApiError.forbidden("That Microsoft account was connected by someone else.");
    }
    return account;
  }

  /**
   * The actor's own accounts; everyone's for an admin. Revoked ones come too, because the
   * screen has to offer reconnecting them: the books read with one stop working until somebody
   * does.
   *
   * @param {object} actor
   * @returns {Promise<object[]>}
   */
  async listAccounts(actor) {
    const rows = await query.listMicrosoftAccounts(isAdmin(actor) ? null : actor.id, true);
    return rows.map(shapeAccount);
  }

  /**
   * Withdraws a grant. The row stays, revoked, so the books that used it still say which
   * account to reconnect. Microsoft is not told -- there is no endpoint for it -- so the
   * person revokes the app from their own account settings if they want the consent gone.
   *
   * @throws {ApiError} 404 when unknown or already revoked, 403 when not the actor's.
   */
  async revoke(accountId, actor) {
    const account = await this.#usable(accountId, actor);
    return shapeAccount(await this.#markRevoked(account));
  }

  async #markRevoked(account) {
    const row = await query.revokeMicrosoftAccount(account.id);
    this.#cache.delete(account.id);
    if (!row) return account;

    await events.emit({
      action: "microsoft_account_revoked",
      target: { table: "microsoft_accounts", id: row.id },
      before: account,
      after: row,
    });
    return row;
  }
}

function isAdmin(actor) {
  return actor?.role === "admin";
}

function mayUse(account, actor) {
  return isAdmin(actor) || Number(account.user_id) === Number(actor?.id);
}

/** snake_case row in, camelCase JSON out -- and never the token, sealed or not. */
function shapeAccount(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userFullName: row.user_full_name ?? null,
    email: row.email,
    displayName: row.display_name,
    tenantId: row.tenant_id,
    scopes: row.scopes,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    sheetCount: row.sheet_count ?? 0,
  };
}

/**
 * The code exchange fails for reasons the person at the browser can act on, and none of
 * them is "reconnect": the identity platform names each one in `error`.
 *
 * @returns {ApiError | Error}
 */
function translateExchange(err) {
  if (!(err instanceof GraphError)) return err;

  switch (err.code) {
    case "invalid_client":
      return ApiError.unavailable(
        "Microsoft rejected the app registration's client secret. Check the secret saved in the settings screen: it must be the secret's Value, not its Id, and it must not have expired.",
      );
    case "unauthorized_client":
      return ApiError.unavailable(
        "Microsoft does not recognise the app registration's client id, or it does not admit this kind of account. Check the client id saved in the settings screen.",
      );
    case "invalid_grant":
      return ApiError.badRequest(
        "The sign-in code was already used or has expired. Start the connection again.",
      );
    default:
      return ApiError.badGateway(`Microsoft refused the sign-in: ${err.message}`);
  }
}

/**
 * A GraphError into the refusal the caller can act on. 401 from Graph means the access
 * token died early -- treated as "reconnect" because accessTokenFor() just refreshed it,
 * so a second refresh would not help. Anything else is returned untouched for the 500.
 *
 * @returns {ApiError | Error}
 */
export function translateGraph(err) {
  if (!(err instanceof GraphError)) return err;

  switch (err.status) {
    case 401:
      return ApiError.conflict(
        "Microsoft rejected the account's access; connect it again.",
      );
    case 403:
      return ApiError.forbidden(
        "The Microsoft account cannot open that workbook.",
      );
    case 404:
      return ApiError.notFound("Workbook or table not found in Microsoft 365.");
    case 400:
      return ApiError.badRequest(`Microsoft refused the request: ${err.message}`);
    default:
      return ApiError.badGateway(
        err.retryAfter
          ? `Microsoft Graph is throttling; retry in ${err.retryAfter}s.`
          : `Microsoft Graph failed: ${err.message}`,
      );
  }
}

export default new Microsoft();
