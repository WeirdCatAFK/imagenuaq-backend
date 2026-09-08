import { Router } from 'express';

import users from '../access/orchestration/users.js';
import auth from '../access/orchestration/auth.js';
import query from '../access/resources/query.js';
import { authenticate, requireRole } from '../middlewares/auth.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

// Everything below is coordination's, not a user's own. Mounted once on the router rather
// than repeated per route, so a route added later cannot be left unguarded by omission --
// the failure mode of per-route guards is silence.
//
// 'admin' is roles.name for coordinación/secretaría particular, the third level in
// RF-USR-02. Area leads are deliberately not included: they direct the work of their area
// (RF-USR-04) but staffing it is not theirs to decide.
router.use(authenticate, requireRole('admin'));

// POST /api/users -- create a staff account and return the link its owner activates it
// with. The account has no password until then, so this response is the only moment the
// invite exists; it is not stored and cannot be read back.
router.post('/', async (req, res) => {
  const user = await users.create(req.body ?? {});
  const inviteToken = await auth.issueInviteToken(user.id);

  // 201 with the created record, and the invite alongside it rather than inside it -- the
  // invite is a credential with a life of its own, not a property of the user.
  res.status(201).json({ user, inviteToken });
});

// POST /api/users/:id/invite -- mint a fresh invite for an account that never activated.
// Invites expire in three days and arrive by email or chat, so the first one going astray
// is ordinary; without this the only remedy would be deleting and recreating the user,
// which changes their id and orphans anything already assigned to them.
router.post('/:id/invite', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('Invalid user id.');
  }

  const user = await query.getAuthUserById(id);
  if (!user) throw ApiError.notFound('User not found.');

  // Re-inviting an active account would be a password reset by another name, and this
  // flow is not one: it hands whoever holds the link a working session. A real reset needs
  // a single-use token of its own -- see completeInvite() in orchestration/auth.js.
  if (user.password_hash !== null) {
    throw ApiError.conflict('This account is already active.');
  }

  res.json({ inviteToken: await auth.issueInviteToken(user.id) });
});

export default router;
