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

router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  const user = await auth.authenticate(email, password);
  const token = await auth.issueToken(user);

  res.json({ token, user });
});

router.post('/activate', async (req, res) => {
  const { token, password } = req.body ?? {};

  if (!token) throw ApiError.badRequest('An invitation token is required.');

  const result = await auth.completeInvite(token, password);
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
