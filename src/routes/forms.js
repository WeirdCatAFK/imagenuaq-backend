// Public forms (RF-SOL-01, RF-MIG-01), opened by someone without an account. No authenticate():
// the token in the path is the credential. Files and the finish call also carry the upload key
// the submission returned, so a link alone cannot write into somebody else's request.
import { Router } from "express";

import forms from "../access/orchestration/forms.js";
import { ApiError } from "../utils/ApiError.js";

/** Submissions one address may send per hour before it gets a 429. */
const SUBMITS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** shortcut: per-process memory, which resets on restart. Move to a table if this ever runs as more than one instance. */
const submits = new Map();

/** Counts a submission against the caller's address. @throws {ApiError} 429 past the hourly cap. */
function limitSubmits(req, _res, next) {
  const now = Date.now();
  const recent = (submits.get(req.ip) ?? []).filter((at) => at > now - HOUR_MS);
  if (recent.length >= SUBMITS_PER_HOUR) {
    throw new ApiError(429, "Too many answers from this address; try again in an hour.");
  }
  recent.push(now);
  submits.set(req.ip, recent);
  next();
}

const router = Router();

router.get("/:token", async (req, res) => {
  res.json({ form: await forms.open(req.params.token) });
});

router.post("/:token", limitSubmits, async (req, res) => {
  res.status(201).json(await forms.submit(req.params.token, req.body ?? {}));
});

router.post("/:token/files", async (req, res) => {
  res.status(201).json(
    await forms.attach(req.params.token, req.query.key, req.query.field, {
      name: req.query.name,
      mime: req.headers["content-type"] ?? null,
      body: req,
    }),
  );
});

router.post("/:token/finish", async (req, res) => {
  res.json(await forms.finish(req.params.token, req.body?.key));
});

export default router;
