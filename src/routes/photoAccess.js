// The client's portal for the photo service. The folio's 8-character code is the only credential.
// Codes are short enough to type, so each address gets a small hourly budget of wrong codes.
// Past it, the address gets 429 until the hour turns.
import { Router } from "express";

import photos from "../access/orchestration/photos.js";
import { ApiError } from "../utils/ApiError.js";
import { idParam } from "../utils/params.js";
import { requestedRange, sendPhoto } from "./photos.js";

/** Lookups one address may miss (404) per hour before the portal refuses it. */
const MISSES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

/** shortcut: per-process memory, which resets on restart. Move to a table if this ever runs as more than one instance. */
const misses = new Map();

/**
 * Refuses an address over its miss budget, and counts this request as a miss if it ends in 404.
 *
 * @throws {ApiError} 429 past the hourly budget.
 */
function limitMisses(req, res, next) {
  const now = Date.now();
  const recent = (misses.get(req.ip) ?? []).filter((at) => at > now - HOUR_MS);
  misses.set(req.ip, recent);
  if (recent.length >= MISSES_PER_HOUR) {
    throw new ApiError(429, "Too many wrong codes from this address; try again in an hour.");
  }
  res.on("finish", () => {
    if (res.statusCode === 404) misses.get(req.ip)?.push(Date.now());
  });
  next();
}

/** Lets the portal, on another origin, show the previews in an <img>. */
function crossOrigin(_req, res, next) {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}

const router = Router();
const fileId = (req) => idParam(req, "fileId", "photo id");

router.use(limitMisses);

router.get("/:code", async (req, res) => {
  res.json({ folio: await photos.portal(req.params.code) });
});

router.put("/:code/registration", async (req, res) => {
  res.json({ folio: await photos.register(req.params.code, req.body) });
});

router.put("/:code/selection", async (req, res) => {
  res.json({ folio: await photos.select(req.params.code, req.body) });
});

router.get("/:code/previews/:fileId", crossOrigin, async (req, res) => {
  sendPhoto(res, await photos.portalPreview(req.params.code, fileId(req), requestedRange(req)));
});

router.get("/:code/thumbnails/:fileId", crossOrigin, async (req, res) => {
  const thumbnail = await photos.portalThumbnail(req.params.code, fileId(req));
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.type("image/jpeg").send(thumbnail);
});

router.get("/:code/files/:fileId", crossOrigin, async (req, res) => {
  sendPhoto(res, await photos.download(req.params.code, fileId(req), req.ip, requestedRange(req)));
});

export default router;
