// Sessions, and the record behind one.
//
// Two blocks, as in routes/users.js: the public routes that produce a session come first
// (login, and activate, whose credential is the invite itself), then `router.use(
// authenticate)`, then everything under /me. A route appended at the bottom therefore
// needs a session by omission.
//
// /me is where a person edits their OWN record. The write half of routes/users.js is
// admin-only and stays that way -- staffing decisions are coordination's (RF-USR-02) --
// but a person's name, address, birthday, picture and password are theirs, and RF-USR-06
// (do not edit what is not yours) cuts both ways. The id is never a parameter here: it is
// read from the session, so there is no path by which one person reaches another's row.
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

router.get('/me', (req, res) => {
  res.json({ user: req.user });
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
