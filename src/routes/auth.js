// Login, invite activation and /me, where a person edits their own record. Public routes come
// first, then authenticate(); the id under /me always comes from the session, never the path.
import express, { Router } from 'express';

import auth from '../access/orchestration/auth.js';
import users, { PICTURE_TYPES } from '../access/orchestration/users.js';
import { authenticate } from '../middlewares/auth.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

/** The same parser routes/users.js mounts on its admin picture route; see the note there. */
const picture = express.raw({ type: PICTURE_TYPES, limit: '2mb' });

/** Failed logins one IP may make on one account within FAILURE_WINDOW_MS. */
const MAX_FAILURES = 20;
/** Failed logins and activations one IP may make in all. Higher, since an office shares one IP. */
const MAX_IP_FAILURES = 200;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Failures per IP, and per IP and account, as `{count, since}`. In memory: one process, few users. */
const failures = new Map();

/**
 * Runs `attempt` and counts a 401 against `req.ip`, and against `req.ip` with `account` when given.
 * @param {import('express').Request} req
 * @param {unknown} account The email being tried, or null when there is none.
 * @param {() => Promise<object>} attempt
 * @throws {ApiError} 429 when throttled, else whatever `attempt` throws.
 */
async function throttled(req, account, attempt) {
  const now = Date.now();
  const limits = [[req.ip, MAX_IP_FAILURES]];
  if (account) limits.push([`${req.ip} ${String(account).trim().toLowerCase().slice(0, 320)}`, MAX_FAILURES]);

  for (const [key, max] of limits) {
    const entry = failures.get(key);
    if (entry && now - entry.since > FAILURE_WINDOW_MS) failures.delete(key);
    if ((failures.get(key)?.count ?? 0) >= max) {
      throw new ApiError(429, 'Too many failed attempts. Try again in a few minutes.');
    }
  }

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 401) {
      if (failures.size > 10_000) failures.clear();
      for (const [key] of limits) {
        const current = failures.get(key) ?? { count: 0, since: now };
        failures.set(key, { ...current, count: current.count + 1 });
      }
    }
    throw err;
  }
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  const user = await throttled(req, email, () => auth.authenticate(email, password));
  const token = await auth.issueToken(user);

  res.json({ token, user });
});

router.post('/activate', async (req, res) => {
  const { token, password } = req.body ?? {};

  if (!token) throw ApiError.badRequest('An invitation token is required.');

  const result = await throttled(req, null, () => auth.completeInvite(token, password));
  res.json(result);
});

router.use(authenticate);

router.get('/me', async (req, res) => {
  res.json({ user: req.user, permissions: await auth.permissionsFor(req.user.roleId) });
});

router.get('/me/profile', async (req, res) => {
  res.json({ user: await users.getById(req.user.id, { asAdmin: true }) });
});

router.patch('/me', async (req, res) => {
  res.json({ user: await users.updateProfile(req.user.id, req.body ?? {}) });
});

router.put('/me/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  await auth.changePassword(req.user.id, currentPassword, newPassword);
  res.status(204).end();
});

router.get('/me/picture', async (req, res) => {
  const { data, mime } = await users.getPicture(req.user.id);
  res.type(mime).send(data);
});

router.put('/me/picture', picture, async (req, res) => {
  await users.setPicture(req.user.id, req.body, req.headers['content-type']);
  res.status(204).end();
});

router.delete('/me/picture', async (req, res) => {
  await users.clearPicture(req.user.id);
  res.status(204).end();
});

export default router;
