import { Router } from 'express';

import auth from '../access/orchestration/auth.js';
import { authenticate } from '../middlewares/auth.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();


router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  const user = await auth.authenticate(email, password);
  const token = await auth.issueToken(user);

  res.json({ token, user });
});

// GET /api/auth/me -- who the presented token says you are. The cheap way for a client to
// find out whether a stored token is still good, and the endpoint that proves the role
// survived the round trip into the token and back out.
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/activate -- redeem an invite: choose a password and get a session.
//
// Public by design, and that is not a hole: the invite token is the credential, it was
// minted for one specific account by an admin, and it stops working the moment the
// password is set. Requiring a session here would be circular -- the caller has no way to
// get one yet.
router.post('/activate', async (req, res) => {
  const { token, password } = req.body ?? {};

  if (!token) throw ApiError.badRequest('An invitation token is required.');

  const result = await auth.completeInvite(token, password);
  res.json(result);
});

export default router;
