// Folders and files (RF-ARC-01, RF-ARC-02). Who may touch which folder is decided in
// orchestration/documents.js. Uploads are the raw request body (no multipart), with the file
// name in the query string; api.js keeps express.json() off this route.
import { Router } from "express";

import documents from "../access/orchestration/documents.js";
import { authenticate, requirePermission } from "../middlewares/auth.js";
import { idParam } from "../utils/params.js";

const router = Router();
const folderId = (req) => idParam(req, "id", "folder id");
const fileId = (req) => idParam(req, "id", "file id");

router.use(authenticate);
router.use(requirePermission("document.read"));

router.get("/folders", async (_req, res) => {
  res.json({ folders: await documents.listTop() });
});

router.get("/folders/:id", async (req, res) => {
  res.json({ folder: await documents.getFolder(folderId(req)) });
});

router.get("/retention", async (_req, res) => {
  res.json({ retention: await documents.getRetention() });
});

router.put("/retention", requirePermission("document.manage"), async (req, res) => {
  res.json({ retention: await documents.setRetention(req.body?.months) });
});

router.get("/:id", async (req, res) => {
  res.json({ file: await documents.getFile(fileId(req)) });
});

router.get("/:id/content", async (req, res) => {
  sendContent(res, await documents.download(fileId(req)));
});

router.get("/folders/:id/links", requirePermission("document.share"), async (req, res) => {
  res.json({ links: await documents.listFolderLinks(folderId(req)) });
});

router.post("/folders/:id/links", requirePermission("document.share"), async (req, res) => {
  const link = await documents.createFolderLink(folderId(req), { expiresAt: req.body?.expiresAt });
  res.status(201).json({ link });
});

router.delete("/links/:id", requirePermission("document.share"), async (req, res) => {
  res.json({ link: await documents.revokeLink(idParam(req, "id", "link id")) });
});

router.use(requirePermission("document.write"));

router.post("/folders", async (req, res) => {
  const { parentId, name } = req.body ?? {};
  res.status(201).json({ folder: await documents.createFolder({ parentId, name }) });
});

router.patch("/folders/:id", async (req, res) => {
  const { name, parentId } = req.body ?? {};
  res.json({ folder: await documents.updateFolder(folderId(req), { name, parentId }) });
});

router.delete("/folders/:id", async (req, res) => {
  res.json({ folder: await documents.deleteFolder(folderId(req)) });
});

router.put("/folders/:id/areas", async (req, res) => {
  res.json({ areas: await documents.setFolderAreas(folderId(req), req.body?.areas) });
});

router.post("/folders/:id/files", async (req, res) => {
  const file = await documents.upload(folderId(req), {
    name: req.query.name,
    mime: req.headers["content-type"] ?? null,
    body: req,
  });
  res.status(201).json({ file });
});

router.patch("/:id", async (req, res) => {
  const { name, folderId: target } = req.body ?? {};
  res.json({ file: await documents.updateFile(fileId(req), { name, folderId: target }) });
});

router.delete("/:id", async (req, res) => {
  res.json({ file: await documents.deleteFile(fileId(req)) });
});

/** Streams a download as an attachment under its stored name and type. */
export function sendContent(res, { file, stream, size }) {
  res.attachment(file.name);
  res.type(file.mime ?? "application/octet-stream");
  if (size != null) res.setHeader("Content-Length", size);
  stream.on("error", (err) => res.destroy(err));
  stream.pipe(res);
}

export default router;
