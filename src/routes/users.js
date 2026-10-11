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
import { authenticate, requireRole } from '../middlewares/auth.js';
import { idParam } from '../utils/params.js';

const router = Router();
const userId = (req) => idParam(req, 'id', 'user id');

/**
 * express.raw() is Express's own body parser, so accepting an upload costs no multipart
 * dependency. The type list is the allow-list; the limit is the only thing standing between
 * a bytea column and an arbitrary payload. Both types come from orchestration, which
 * validates the value it is handed rather than trusting this filter.
 */
const picture = express.raw({ type: PICTURE_TYPES, limit: '2mb' });

router.use(authenticate);

const asAdmin = (req) => req.user.role === 'admin';

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

router.post('/', async (req, res) => {
  const user = await users.create(req.body ?? {});
  const inviteToken = await auth.issueInviteToken(user.id);

  res.status(201).json({ user, inviteToken });
});


router.post('/:id/invite', async (req, res) => {
  res.json({ inviteToken: await users.reissueInvite(userId(req)) });
});

router.patch('/:id', async (req, res) => {
  res.json({ user: await users.update(userId(req), req.body ?? {}) });
});

router.delete('/:id', async (req, res) => {
  res.json({ user: await users.softDelete(userId(req)) });
});

router.put('/:id/picture', picture, async (req, res) => {
  await users.setPicture(userId(req), req.body, req.headers['content-type']);
  res.status(204).end();
});

router.delete('/:id/picture', async (req, res) => {
  await users.clearPicture(userId(req));
  res.status(204).end();
});

export default router;
