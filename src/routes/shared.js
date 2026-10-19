// Share links, opened by someone without an account (RF-ARC-03, RF-EXT-03). No
// authenticate(): the token in the path is the credential, and orchestration/documents.js
// checks it is known, unrevoked and unexpired on every request. Read-only by construction --
// there is no write route here.
import { Router } from "express";

import documents from "../access/orchestration/documents.js";
import { sendContent } from "./documents.js";

const router = Router();

router.get("/:token", async (req, res) => {
  res.json(await documents.sharedFolder(req.params.token));
});

router.get("/:token/folders/:id", async (req, res) => {
  res.json(await documents.sharedFolder(req.params.token, req.params.id));
});

router.get("/:token/files/:id/content", async (req, res) => {
  sendContent(res, await documents.sharedDownload(req.params.token, req.params.id));
});

export default router;
