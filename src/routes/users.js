// Staff accounts.
//
// Two blocks, as in routes/areas.js: the reads any signed-in colleague may perform come
// first, then `router.use(requireRole('admin'))`, then everything that changes a record.
// A route appended at the bottom is therefore admin-gated by omission rather than left
// open by mistake, which is the safe direction to be wrong in.
//
// 'admin' is roles.name for coordinación/secretaría particular, the third level in
// RF-USR-02. Area leads are deliberately not included: they direct the work of their area
// (RF-USR-04) but staffing it is not theirs to decide.
import express, { Router } from 'express';

import users, { PICTURE_TYPES } from '../access/orchestration/users.js';
import auth from '../access/orchestration/auth.js';
import query from '../access/resources/query.js';
import { authenticate, requireRole } from '../middlewares/auth.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

// express.raw() is Express's own body parser, so accepting an upload costs no multipart
// dependency. The type list is the allow-list; the limit is the only thing standing between
// a bytea column and an arbitrary payload. Both types come from orchestration, which
// validates the value it is handed rather than trusting this filter.
const picture = express.raw({ type: PICTURE_TYPES, limit: '2mb' });

router.use(authenticate);

const asAdmin = (req) => req.user.role === 'admin';

// GET /api/users/search -- declared BEFORE '/:id'. Express matches in declaration order, so
// the other way round `/search` is captured by `:id`, fails Number.isInteger and returns
// "Invalid user id." for a URL that is not an id at all.
router.get('/search', async (req, res) => {
  const results = await users.search(req.query.q, { limit: req.query.limit });
  res.json({ users: results });
});

router.get('/', async (req, res) => {
  res.json(
    await users.list({
      areaId: req.query.areaId,
      roleId: req.query.roleId,
      includeDeleted: req.query.includeDeleted === 'true',
      limit: req.query.limit,
      offset: req.query.offset,
      asAdmin: asAdmin(req),
    }),
  );
});

router.get('/:id', async (req, res) => {
  res.json({ user: await users.getById(userId(req), { asAdmin: asAdmin(req) }) });
});

router.get('/:id/picture', async (req, res) => {
  const { data, mime } = await users.getPicture(userId(req));
  res.type(mime).send(data);
});

router.use(requireRole('admin'));

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
  const user = await query.getAuthUserById(userId(req));
  if (!user) throw ApiError.notFound('User not found.');

  // Re-inviting an active account would be a password reset by another name, and this
  // flow is not one: it hands whoever holds the link a working session. A real reset needs
  // a single-use token of its own -- see completeInvite() in orchestration/auth.js.
  if (user.password_hash !== null) {
    throw ApiError.conflict('This account is already active.');
  }

  res.json({ inviteToken: await auth.issueInviteToken(user.id) });
});

router.patch('/:id', async (req, res) => {
  res.json({ user: await users.update(userId(req), req.body ?? {}) });
});

router.delete('/:id', async (req, res) => {
  res.json({ user: await users.softDelete(userId(req)) });
});

// express.raw() leaves an empty buffer when the Content-Type is off the allow-list, so an
// unsupported image would otherwise arrive indistinguishable from no body at all. The
// header is passed through and orchestration decides, which keeps the refusal in one place.
router.put('/:id/picture', picture, async (req, res) => {
  await users.setPicture(userId(req), req.body, req.headers['content-type']);
  res.status(204).end();
});

router.delete('/:id/picture', async (req, res) => {
  await users.clearPicture(userId(req));
  res.status(204).end();
});

/** @throws {ApiError} 400 when the path segment is not a positive integer. */
function userId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest('Invalid user id.');
  }
  return id;
}

export default router;
