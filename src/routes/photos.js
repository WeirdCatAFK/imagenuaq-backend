// The photo service's desk (RF-PRY-06): groups, folios, payments, photos, the catalog and retention.
// Reading needs `photo.read`. Writes and the sheets with the clients' codes need `photo.manage`.
// Uploads go in raw parts and downloads in byte ranges, so each request fits a Cloudflare tunnel.
import { Router } from "express";

import photos from "../access/orchestration/photos.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";
import { sendContent } from "./documents.js";

const router = Router();
const read = requirePermission("photo.read");
const manage = requirePermission("photo.manage");
const id = (req) => idParam(req, "id", "id");

/**
 * The byte range a request asks for in its `Range` header, as `{start, end}` with `end` null for
 * "to the end". Null when there is none or it is not a single `bytes=` range.
 */
export function requestedRange(req) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (!match) return null;
  const range = { start: Number(match[1]), end: match[2] === "" ? null : Number(match[2]) };
  return range.end !== null && range.end < range.start ? null : range;
}

/** Sends a photo whole (200) or one piece of it (206 with Content-Range), always saying it takes ranges. */
export function sendPhoto(res, content) {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Disposition");
  if (content.range) {
    const { start, end, total } = content.range;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  }
  sendContent(res, content);
}

router.use(authenticate);

router.get("/retention", read, async (_req, res) => {
  res.json({ retention: await photos.getRetention() });
});

router.put("/retention", manage, async (req, res) => {
  res.json({ retention: await photos.setRetention(req.body) });
});

router.get("/packages", read, async (_req, res) => {
  res.json({ packages: await photos.listPackages() });
});

router.post("/packages", manage, async (req, res) => {
  res.status(201).json({ package: await photos.createPackage(req.body) });
});

router.patch("/packages/:id", manage, async (req, res) => {
  res.json({ package: await photos.updatePackage(id(req), req.body) });
});

router.get("/groups", read, async (_req, res) => {
  res.json({ groups: await photos.listGroups() });
});

router.post("/groups", manage, async (req, res) => {
  res.status(201).json({ group: await photos.createGroup(req.body) });
});

router.get("/groups/:id", read, async (req, res) => {
  res.json({ group: await photos.getGroup(id(req)) });
});

router.patch("/groups/:id", manage, async (req, res) => {
  res.json({ group: await photos.updateGroup(id(req), req.body) });
});

router.get("/groups/:id/folios", read, async (req, res) => {
  res.json({ folios: await photos.listFolios(id(req)) });
});

router.post("/groups/:id/folios", manage, async (req, res) => {
  res.status(201).json({ folios: await photos.addFolios(id(req), req.body) });
});

router.get("/groups/:id/sheets", manage, async (req, res) => {
  res.json({ folios: await photos.listSheets(id(req)) });
});

router.get("/folios/lookup", read, async (req, res) => {
  res.json({ folio: await photos.findFolio(req.query.code) });
});

router.get("/folios/:id", read, async (req, res) => {
  res.json({ folio: await photos.getFolio(id(req)) });
});

router.patch("/folios/:id", manage, async (req, res) => {
  res.json({ folio: await photos.updateFolio(id(req), req.body) });
});

router.post("/folios/:id/payment", manage, async (req, res) => {
  res.json({ folio: await photos.recordPayment(id(req), req.body) });
});

router.post("/folios/:id/files", manage, async (req, res) => {
  const file = await photos.uploadPhoto(id(req), {
    kind: req.query.kind,
    name: req.query.name,
    mime: req.headers["content-type"] ?? null,
    body: req,
  });
  res.status(201).json({ file });
});

router.post("/folios/:id/uploads", manage, async (req, res) => {
  res.status(201).json({ uploadId: await photos.beginUpload(id(req), req.body) });
});

router.put("/uploads/:uploadId/:partNumber", manage, async (req, res) => {
  res.json(await photos.uploadChunk(req.params.uploadId, req.params.partNumber, req));
});

router.post("/uploads/:uploadId/complete", manage, async (req, res) => {
  res.status(201).json({ file: await photos.finishUpload(req.params.uploadId) });
});

router.delete("/uploads/:uploadId", manage, async (req, res) => {
  await photos.abortUpload(req.params.uploadId);
  res.status(204).end();
});

router.post("/folios/:id/ready", manage, async (req, res) => {
  res.json({ folio: await photos.markReady(id(req)) });
});

router.post("/folios/:id/printed", manage, async (req, res) => {
  res.json({ folio: await photos.markPrinted(id(req)) });
});

router.post("/folios/:id/delivered", manage, async (req, res) => {
  res.json({ folio: await photos.markDelivered(id(req)) });
});

router.get("/files/:id/content", read, async (req, res) => {
  sendPhoto(res, await photos.readPhoto(id(req), requestedRange(req)));
});

router.get("/files/:id/preview", read, async (req, res) => {
  sendPhoto(res, await photos.readPreview(id(req), requestedRange(req)));
});

router.delete("/files/:id", manage, async (req, res) => {
  await photos.deletePhoto(id(req));
  res.status(204).end();
});

export default router;
