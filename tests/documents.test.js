import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { startServer } from "./helpers/server.js";
import documents from "../src/access/orchestration/documents.js";
import { statContent } from "../src/access/primitives/minioStorage.js";
import {
  reset,
  resetCases,
  createActive,
  areaId,
  sql,
  tokenFor,
  logsFor,
  grantPermissions,
} from "./helpers/fixtures.js";

describe("/api/documents", () => {
  let server;
  let tokens;
  let users;
  let areaX;
  let areaY;

  const ACCOUNTS = {
    admin: "coordinacion@uaq.mx",
    owner: "duena@uaq.mx",
    colleague: "colega@uaq.mx",
    outsider: "ajeno@uaq.mx",
    finance: "finanzas@uaq.mx",
  };

  before(async () => {
    server = await startServer();
    await reset();

    areaX = { id: await areaId("Diseño Gráfico") };
    areaY = { id: await areaId("Diseño Web") };

    users = {
      admin: await createActive({ email: ACCOUNTS.admin, role: "admin" }),
      owner: await createActive({ email: ACCOUNTS.owner }),
      colleague: await createActive({ email: ACCOUNTS.colleague }),
      outsider: await createActive({ email: ACCOUNTS.outsider }),
      finance: await createActive({ email: ACCOUNTS.finance, role: "finance" }),
    };

    tokens = {};
    for (const [key, email] of Object.entries(ACCOUNTS)) tokens[key] = await tokenFor(server, email);

    await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write"]);
  });

  after(async () => {
    await grantPermissions(server, tokens.admin, "worker", []);
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(Object.values(ACCOUNTS));
    for (const [user, area] of [
      [users.owner, areaX],
      [users.colleague, areaX],
      [users.outsider, areaY],
    ]) {
      await sql(
        "insert into area_members (user_id, area_id, is_area_leader) values ($1, $2, false)",
        [user.id, area.id],
      );
    }
  });

  const createFolder = (body, token = tokens.owner) =>
    server.post("/api/documents/folders", { token, body });

  const upload = (folderId, name, bytes, { token = tokens.owner, type = "application/octet-stream" } = {}) =>
    server.post(`/api/documents/folders/${folderId}/files?name=${encodeURIComponent(name)}`, {
      token,
      raw: bytes,
      headers: { "content-type": type },
    });

  /** Downloads raw bytes, since server.request() decodes the body as text. */
  const download = async (fileId, token = tokens.owner) => {
    const res = await fetch(`${server.base}/api/documents/${fileId}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };

  const root = async (name = "Proyectos") => (await createFolder({ name })).body.folder;

  const share = (folderId, areas, token = tokens.owner) =>
    server.put(`/api/documents/folders/${folderId}/areas`, { token, body: { areas } });

  describe("upload and download", () => {
    test("stores the bytes and serves them back with the name and type", async () => {
      const folder = await root();
      const bytes = randomBytes(200 * 1024);

      const res = await upload(folder.id, "propuesta final.pdf", bytes, { type: "application/pdf" });

      assert.equal(res.status, 201);
      assert.equal(res.body.file.name, "propuesta final.pdf");
      assert.equal(res.body.file.size, bytes.length);
      assert.equal(res.body.file.mime, "application/pdf");
      assert.match(res.body.file.hash, /^[0-9a-f]{64}$/);

      const got = await download(res.body.file.id);
      assert.equal(got.status, 200);
      assert.ok(got.bytes.equals(bytes));
      assert.equal(got.headers.get("content-type"), "application/pdf");
      assert.match(got.headers.get("content-disposition"), /attachment; filename="propuesta final.pdf"/);
    });

    test("a JSON file arrives intact rather than being parsed as the request body", async () => {
      const folder = await root();
      const bytes = Buffer.from('{"a": 1, "b": [true]}');

      const res = await upload(folder.id, "datos.json", bytes, { type: "application/json" });

      assert.equal(res.status, 201);
      assert.equal(res.body.file.size, bytes.length);
      assert.ok((await download(res.body.file.id)).bytes.equals(bytes));
    });

    test("the same bytes under two names share one hash", async () => {
      const folder = await root();
      const bytes = randomBytes(1024);

      const first = await upload(folder.id, "a.bin", bytes);
      const second = await upload(folder.id, "b.bin", bytes);

      assert.equal(second.status, 201);
      assert.notEqual(first.body.file.id, second.body.file.id);
      assert.equal(first.body.file.hash, second.body.file.hash);
    });

    test("two files and two folders may share a name, told apart by id", async () => {
      const folder = await root();
      const first = await upload(folder.id, "a.bin", randomBytes(10));
      const second = await upload(folder.id, "a.bin", randomBytes(10));
      await createFolder({ parentId: folder.id, name: "Diseño" });
      const sameFolder = await createFolder({ parentId: folder.id, name: "Diseño" });

      assert.equal(second.status, 201);
      assert.equal(sameFolder.status, 201);
      assert.notEqual(first.body.file.id, second.body.file.id);

      const listing = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });
      assert.deepEqual(listing.body.folder.files.map((f) => f.name), ["a.bin", "a.bin"]);
      assert.deepEqual(listing.body.folder.folders.map((f) => f.name), ["Diseño", "Diseño"]);
    });

    test("a name with a slash is a 400", async () => {
      const folder = await root();
      const res = await upload(folder.id, "../a.bin", randomBytes(10));
      assert.equal(res.status, 400);
    });

    test("past MAX_UPLOAD_BYTES is a 413 and stores nothing", async () => {
      const folder = await root();
      const previous = process.env.MAX_UPLOAD_BYTES;
      process.env.MAX_UPLOAD_BYTES = "1024";
      try {
        const res = await upload(folder.id, "grande.bin", randomBytes(4096));
        assert.equal(res.status, 413);
      } finally {
        process.env.MAX_UPLOAD_BYTES = previous;
      }

      const listing = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });
      assert.deepEqual(listing.body.folder.files, []);
    });

    test("records the upload in the audit trail", async () => {
      const folder = await root();
      const res = await upload(folder.id, "a.bin", randomBytes(10));

      const logs = await logsFor("files", res.body.file.id);
      assert.deepEqual(logs.map((l) => l.action), ["file_uploaded"]);
    });
  });

  describe("the tree", () => {
    test("renaming and moving a file keeps its content", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const bytes = randomBytes(2048);
      const file = (await upload(folder.id, "a.bin", bytes)).body.file;

      const res = await server.patch(`/api/documents/${file.id}`, {
        token: tokens.owner,
        body: { name: "b.bin", folderId: sub.id },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.file.name, "b.bin");
      assert.equal(res.body.file.folderId, sub.id);
      assert.ok((await download(file.id)).bytes.equals(bytes));
    });

    test("a folder lists its subfolders and files", async () => {
      const folder = await root();
      await createFolder({ parentId: folder.id, name: "Diseño" });
      await upload(folder.id, "a.bin", randomBytes(10));

      const res = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });

      assert.equal(res.status, 200);
      assert.equal(res.body.folder.access, "owner");
      assert.deepEqual(res.body.folder.folders.map((f) => f.name), ["Diseño"]);
      assert.deepEqual(res.body.folder.files.map((f) => f.name), ["a.bin"]);
    });

    test("moving a folder into its own subtree is a 400", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;

      const res = await server.patch(`/api/documents/folders/${folder.id}`, {
        token: tokens.owner,
        body: { parentId: sub.id },
      });

      assert.equal(res.status, 400);
    });

    test("deleting a folder takes its subtree and files with it", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const file = (await upload(sub.id, "a.bin", randomBytes(10))).body.file;

      const res = await server.delete(`/api/documents/folders/${folder.id}`, { token: tokens.owner });

      assert.equal(res.status, 200);
      assert.equal(res.body.folder.foldersDeleted, 1);
      assert.equal(res.body.folder.filesDeleted, 1);
      assert.equal((await server.get(`/api/documents/folders/${sub.id}`, { token: tokens.owner })).status, 404);
      assert.equal((await server.get(`/api/documents/${file.id}`, { token: tokens.owner })).status, 404);
    });

    test("a deleted file is gone, and its name is free again", async () => {
      const folder = await root();
      const file = (await upload(folder.id, "a.bin", randomBytes(10))).body.file;

      assert.equal((await server.delete(`/api/documents/${file.id}`, { token: tokens.owner })).status, 200);
      assert.equal((await server.get(`/api/documents/${file.id}`, { token: tokens.owner })).status, 404);
      assert.equal((await upload(folder.id, "a.bin", randomBytes(10))).status, 201);
    });
  });

  describe("empty folders and search", () => {
    const search = (params, token = tokens.owner) =>
      server.get(`/api/documents/search?${new URLSearchParams(params)}`, { token });

    test("a folder is empty until a file lies somewhere beneath it", async () => {
      const folder = await root();
      const full = (await createFolder({ parentId: folder.id, name: "Con archivo" })).body.folder;
      const deep = (await createFolder({ parentId: full.id, name: "Adentro" })).body.folder;
      await upload(deep.id, "a.bin", randomBytes(10));
      const hollow = (await createFolder({ parentId: folder.id, name: "Sin archivo" })).body.folder;
      await createFolder({ parentId: hollow.id, name: "Vacía" });

      const listing = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });
      const top = await server.get("/api/documents/folders", { token: tokens.owner });

      assert.deepEqual(
        listing.body.folder.folders.map((f) => [f.name, f.empty]),
        [["Con archivo", false], ["Sin archivo", true]],
      );
      assert.equal(top.body.folders.find((f) => f.id === folder.id).empty, false);
    });

    test("a folder whose only file was deleted is empty again", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const file = (await upload(sub.id, "a.bin", randomBytes(10))).body.file;
      await server.delete(`/api/documents/${file.id}`, { token: tokens.owner });

      const listing = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });

      assert.equal(listing.body.folder.folders[0].empty, true);
    });

    test("finds a file by part of its name, whatever the case, with the path to it", async () => {
      const tag = randomBytes(4).toString("hex");
      const folder = await root(`Proyectos ${tag}`);
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const file = (await upload(sub.id, `Cartel FINAL ${tag}.pdf`, randomBytes(10))).body.file;
      await upload(sub.id, "otro.bin", randomBytes(10));

      const res = await search({ q: `final ${tag}` }, tokens.admin);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.files.map((f) => f.id), [file.id]);
      assert.deepEqual(res.body.files[0].path, [
        { id: folder.id, name: `Proyectos ${tag}` },
        { id: sub.id, name: "Diseño" },
      ]);
    });

    test("within a folder, the path starts there and nothing outside it shows", async () => {
      const tag = randomBytes(4).toString("hex");
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const deep = (await createFolder({ parentId: sub.id, name: "Cartel" })).body.folder;
      const inside = (await upload(deep.id, `${tag}.pdf`, randomBytes(10))).body.file;
      await upload(folder.id, `${tag}.png`, randomBytes(10));

      const res = await search({ q: tag, folderId: sub.id });

      assert.deepEqual(res.body.files.map((f) => f.id), [inside.id]);
      assert.deepEqual(res.body.files[0].path, [
        { id: sub.id, name: "Diseño" },
        { id: deep.id, name: "Cartel" },
      ]);
    });

    test("anyone may search everything, but not with a blank query", async () => {
      assert.equal((await search({ q: "a" })).status, 200);
      assert.equal((await search({ q: " " })).status, 400);
    });

    test("searching within a folder that does not exist is a 404", async () => {
      const res = await search({ q: "a", folderId: 999_999_999 });

      assert.equal(res.status, 404);
    });

    test("a colleague finds files in folders their area was never given", async () => {
      const tag = randomBytes(4).toString("hex");
      const folder = await root();
      const web = (await createFolder({ parentId: folder.id, name: "Web" })).body.folder;
      await share(web.id, [{ areaId: areaY.id, level: "write" }]);
      const first = (await upload(folder.id, `${tag}-a.bin`, randomBytes(10))).body.file;
      const second = (await upload(web.id, `${tag}-b.bin`, randomBytes(10))).body.file;

      const res = await search({ q: tag }, tokens.colleague);

      assert.deepEqual(res.body.files.map((f) => f.id), [first.id, second.id]);
    });

    test("finds a project's folder by its title or key, but not within a folder", async () => {
      const tag = randomBytes(4).toString("hex");
      const project = (await server.post("/api/projects", {
        token: tokens.admin,
        body: { title: `Campaña ${tag}` },
      })).body.project;

      const byTitle = await search({ q: `campaña ${tag}` }, tokens.admin);
      const byKey = await search({ q: project.key }, tokens.admin);
      const within = await search({ q: tag, folderId: project.folderId }, tokens.admin);

      assert.deepEqual(byTitle.body.folders.map((f) => f.id), [project.folderId]);
      assert.equal(byTitle.body.folders[0].project.title, `Campaña ${tag}`);
      assert.deepEqual(byTitle.body.folders[0].path, [{ id: project.folderId, name: project.key }]);
      assert.ok(byKey.body.folders.some((f) => f.id === project.folderId));
      assert.deepEqual(within.body.folders, []);
    });

    test("% and _ in the query match themselves", async () => {
      const folder = await root();
      const literal = (await upload(folder.id, "a_b%.bin", randomBytes(10))).body.file;
      await upload(folder.id, "axbz.bin", randomBytes(10));

      const res = await search({ q: "a_b%", folderId: folder.id });

      assert.deepEqual(res.body.files.map((f) => f.id), [literal.id]);
    });

    test("a deleted file, or one in a deleted folder, is not found", async () => {
      const tag = randomBytes(4).toString("hex");
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const gone = (await upload(folder.id, `${tag}-a.bin`, randomBytes(10))).body.file;
      await upload(sub.id, `${tag}-b.bin`, randomBytes(10));
      await server.delete(`/api/documents/${gone.id}`, { token: tokens.owner });
      await server.delete(`/api/documents/folders/${sub.id}`, { token: tokens.owner });

      const res = await search({ q: tag, folderId: folder.id });

      assert.deepEqual(res.body.files, []);
    });
  });

  describe("who may touch which folder", () => {
    test("anyone reads an unshared folder, but cannot write in it", async () => {
      const folder = await root();
      const file = (await upload(folder.id, "a.bin", randomBytes(10))).body.file;

      const res = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.colleague });

      assert.equal(res.status, 200);
      assert.equal(res.body.folder.access, "read");
      assert.equal((await download(file.id, tokens.colleague)).status, 200);
      assert.equal((await upload(folder.id, "b.bin", randomBytes(10), { token: tokens.colleague })).status, 403);
    });

    test("read access lists and downloads but cannot upload", async () => {
      const folder = await root();
      const file = (await upload(folder.id, "a.bin", randomBytes(10))).body.file;
      assert.equal((await share(folder.id, [{ areaId: areaX.id, level: "read" }])).status, 200);

      const listing = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.colleague });
      assert.equal(listing.status, 200);
      assert.equal(listing.body.folder.access, "read");
      assert.equal((await download(file.id, tokens.colleague)).status, 200);
      assert.equal((await upload(folder.id, "b.bin", randomBytes(10), { token: tokens.colleague })).status, 403);
    });

    test("write access uploads into subfolders but cannot delete the folder", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);

      const res = await upload(sub.id, "b.bin", randomBytes(10), { token: tokens.colleague });
      assert.equal(res.status, 201);

      const del = await server.delete(`/api/documents/folders/${folder.id}`, { token: tokens.colleague });
      assert.equal(del.status, 403);
    });

    test("with write, a colleague deletes their own upload but not the owner's", async () => {
      const folder = await root();
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);
      const mine = (await upload(folder.id, "mio.bin", randomBytes(10), { token: tokens.colleague })).body.file;
      const theirs = (await upload(folder.id, "suyo.bin", randomBytes(10))).body.file;

      assert.equal((await server.delete(`/api/documents/${mine.id}`, { token: tokens.colleague })).status, 200);
      assert.equal((await server.delete(`/api/documents/${theirs.id}`, { token: tokens.colleague })).status, 403);
    });

    test("document.manage lets write access delete and reshare others' work", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const file = (await upload(folder.id, "suyo.bin", randomBytes(10))).body.file;
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);

      await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write", "document.manage"]);
      try {
        assert.equal((await server.delete(`/api/documents/${file.id}`, { token: tokens.colleague })).status, 200);
        const grants = [{ areaId: areaX.id, level: "write" }, { areaId: areaY.id, level: "read" }];
        assert.equal((await share(sub.id, grants, tokens.colleague)).status, 200);
        assert.equal((await server.delete(`/api/documents/folders/${sub.id}`, { token: tokens.colleague })).status, 200);
      } finally {
        await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write"]);
      }
    });

    test("document.manage does not reach folders that are only readable", async () => {
      const folder = await root();
      await share(folder.id, [{ areaId: areaX.id, level: "read" }]);

      await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write", "document.manage"]);
      try {
        assert.equal((await server.delete(`/api/documents/folders/${folder.id}`, { token: tokens.colleague })).status, 403);
      } finally {
        await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write"]);
      }
    });

    test("every root appears in everyone's top folders, shared or not", async () => {
      const folder = await root();

      const res = await server.get("/api/documents/folders", { token: tokens.outsider });

      assert.ok(res.body.folders.some((f) => f.id === folder.id));
    });

    test("another area reads a folder shared with someone else, but cannot write", async () => {
      const folder = await root();
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);

      const res = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.outsider });

      assert.equal(res.status, 200);
      assert.equal(res.body.folder.access, "read");
      assert.equal((await upload(folder.id, "b.bin", randomBytes(10), { token: tokens.outsider })).status, 403);
    });

    test("the nearest ancestor with grants decides who writes", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Web" })).body.folder;
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);
      await share(sub.id, [{ areaId: areaY.id, level: "write" }]);

      const asColleague = await server.get(`/api/documents/folders/${sub.id}`, { token: tokens.colleague });
      const asOutsider = await server.get(`/api/documents/folders/${sub.id}`, { token: tokens.outsider });

      assert.equal(asColleague.body.folder.access, "read");
      assert.equal(asOutsider.body.folder.access, "write");
    });

    test("a folder with no grants of its own reports the ones it inherits", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Diseño" })).body.folder;
      const deep = (await createFolder({ parentId: sub.id, name: "Cartel" })).body.folder;
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);

      const inside = await server.get(`/api/documents/folders/${deep.id}`, { token: tokens.owner });
      const top = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });

      assert.deepEqual(inside.body.folder.areas, []);
      assert.equal(inside.body.folder.inherited.folderId, folder.id);
      assert.equal(inside.body.folder.inherited.folderName, "Proyectos");
      assert.deepEqual(
        inside.body.folder.inherited.areas.map((g) => [g.areaId, g.level]),
        [[areaX.id, "write"]],
      );
      assert.equal(top.body.folder.inherited, null);
    });

    test("without document.manage, only the owner changes who a folder is shared with", async () => {
      const folder = await root();
      await share(folder.id, [{ areaId: areaX.id, level: "write" }]);

      const res = await share(folder.id, [], tokens.colleague);

      assert.equal(res.status, 403);
    });

    test("an admin reaches every folder", async () => {
      const folder = await root();

      const res = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.admin });

      assert.equal(res.status, 200);
      assert.equal(res.body.folder.access, "owner");
    });

    test("a role without document.read gets a 403", async () => {
      const res = await server.get("/api/documents/folders", { token: tokens.finance });
      assert.equal(res.status, 403);
    });
  });

  describe("share links", () => {
    const inADay = () => new Date(Date.now() + 86_400_000).toISOString();

    const createLink = (folderId, expiresAt = inADay(), token = tokens.admin) =>
      server.post(`/api/documents/folders/${folderId}/links`, { token, body: { expiresAt } });

    /** Downloads through a link, with no session. */
    const sharedDownload = async (linkToken, fileId) => {
      const res = await fetch(`${server.base}/api/shared/${linkToken}/files/${fileId}/content`);
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    };

    test("opens the folder and what lies beneath it, read-only, with no session", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Entregables" })).body.folder;
      const bytes = randomBytes(1024);
      const file = (await upload(sub.id, "logo.png", bytes, { type: "image/png" })).body.file;

      const res = await createLink(folder.id);
      assert.equal(res.status, 201);
      const { token } = res.body.link;
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);

      const top = await server.get(`/api/shared/${token}`);
      assert.equal(top.status, 200);
      assert.equal(top.body.folder.name, "Proyectos");
      assert.deepEqual(top.body.folder.folders, [{ id: sub.id, name: "Entregables" }]);
      assert.equal(top.body.folder.ownerId, undefined);

      const inner = await server.get(`/api/shared/${token}/folders/${sub.id}`);
      assert.deepEqual(inner.body.folder.files.map((f) => f.name), ["logo.png"]);
      assert.equal(inner.body.folder.files[0].hash, undefined);

      const got = await sharedDownload(token, file.id);
      assert.equal(got.status, 200);
      assert.ok(got.bytes.equals(bytes));

      const logs = await logsFor("files", file.id);
      assert.deepEqual(logs.map((l) => l.action), ["file_uploaded", "file_downloaded"]);
    });

    test("nothing outside the linked folder is reachable", async () => {
      const shared = await root("Compartida");
      const other = await root("Privada");
      const file = (await upload(other.id, "secreto.bin", randomBytes(10))).body.file;
      const { token } = (await createLink(shared.id)).body.link;

      assert.equal((await server.get(`/api/shared/${token}/folders/${other.id}`)).status, 404);
      assert.equal((await sharedDownload(token, file.id)).status, 404);
    });

    test("a revoked, expired or deleted link stops working", async () => {
      const folder = await root();
      const revoked = (await createLink(folder.id)).body.link;
      const expired = (await createLink(folder.id)).body.link;

      assert.equal((await server.delete(`/api/documents/links/${revoked.id}`, { token: tokens.admin })).status, 200);
      await sql("update access_tokens set expires_at = now() - interval '1 minute' where id = $1", [expired.id]);

      assert.equal((await server.get(`/api/shared/${revoked.token}`)).status, 404);
      assert.equal((await server.get(`/api/shared/${expired.token}`)).status, 404);

      const live = (await createLink(folder.id)).body.link;
      await server.delete(`/api/documents/folders/${folder.id}`, { token: tokens.owner });
      assert.equal((await server.get(`/api/shared/${live.token}`)).status, 404);
    });

    test("lists the working links without their tokens", async () => {
      const folder = await root();
      const link = (await createLink(folder.id)).body.link;

      const res = await server.get(`/api/documents/folders/${folder.id}/links`, { token: tokens.admin });

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.links.map((l) => l.id), [link.id]);
      assert.equal(res.body.links[0].token, undefined);
    });

    test("an expiry in the past is a 400", async () => {
      const folder = await root();
      const res = await createLink(folder.id, new Date(Date.now() - 1000).toISOString());
      assert.equal(res.status, 400);
    });

    test("issuing a link needs document.share, even for the owner", async () => {
      const folder = await root();
      assert.equal((await createLink(folder.id, inADay(), tokens.owner)).status, 403);
    });

    test("document.share links any folder, since every folder is readable", async () => {
      const folder = await root();

      await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write", "document.share"]);
      try {
        assert.equal((await createLink(folder.id, inADay(), tokens.colleague)).status, 201);
        assert.equal((await createLink(folder.id, inADay(), tokens.owner)).status, 201);
      } finally {
        await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write"]);
      }
    });

    test("an unknown token is a 404", async () => {
      assert.equal((await server.get(`/api/shared/${"x".repeat(43)}`)).status, 404);
    });
  });
  describe("managing links", () => {
    const inADay = () => new Date(Date.now() + 86_400_000).toISOString();
    const createLink = (folderId) =>
      server.post(`/api/documents/folders/${folderId}/links`, {
        token: tokens.admin,
        body: { expiresAt: inADay() },
      });

    test("lists every working link with its folder, and a folder counts its own", async () => {
      const folder = await root();
      const sub = (await createFolder({ parentId: folder.id, name: "Entregables" })).body.folder;
      const working = (await createLink(sub.id)).body.link;
      const revoked = (await createLink(sub.id)).body.link;
      const expired = (await createLink(sub.id)).body.link;
      await server.delete(`/api/documents/links/${revoked.id}`, { token: tokens.admin });
      await sql("update access_tokens set expires_at = now() - interval '1 minute' where id = $1", [expired.id]);

      const res = await server.get("/api/documents/links", { token: tokens.admin });
      const listing = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });

      assert.equal(res.status, 200);
      const mine = res.body.links.filter((link) => link.folder.id === sub.id);
      assert.deepEqual(mine.map((link) => link.id), [working.id]);
      assert.equal(mine[0].token, undefined);
      assert.deepEqual(mine[0].folder.path, [
        { id: folder.id, name: "Proyectos" },
        { id: sub.id, name: "Entregables" },
      ]);
      assert.equal(listing.body.folder.folders[0].links, 1);
    });

    test("listing every link needs document.share", async () => {
      const res = await server.get("/api/documents/links", { token: tokens.owner });
      assert.equal(res.status, 403);
    });
  });

  describe("project folders", () => {
    const createProject = async (stages = []) => {
      const res = await server.post("/api/projects", {
        token: tokens.admin,
        body: { title: "Proyecto", stages },
      });
      assert.equal(res.status, 201);
      return res.body.project;
    };
    const projectFolder = (projectId, token = tokens.owner) =>
      server.get(`/api/projects/${projectId}/folder`, { token });

    test("a new project gets a folder named by its key, writable by its areas", async () => {
      await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write", "project.read"]);
      try {
        const project = await createProject([{ areaId: areaX.id, title: "Diseño" }]);
        assert.ok(project.folderId);

        const res = await projectFolder(project.id);
        assert.equal(res.status, 200);
        assert.equal(res.body.folder.id, project.folderId);
        assert.equal(res.body.folder.name, project.key);
        assert.equal(res.body.folder.access, "write");
        assert.equal((await upload(project.folderId, "a.bin", randomBytes(16))).status, 201);

        const outside = await projectFolder(project.id, tokens.outsider);
        assert.equal(outside.status, 200);
        assert.equal(outside.body.folder.access, "read");
      } finally {
        await grantPermissions(server, tokens.admin, "worker", ["document.read", "document.write"]);
      }
    });

    test("adding a stage for a new area grants it write, and keeps a manual downgrade", async () => {
      const project = await createProject([{ areaId: areaX.id, title: "Diseño" }]);
      await share(project.folderId, [{ areaId: areaX.id, level: "read" }], tokens.admin);

      const added = await server.post(`/api/projects/${project.id}/stages`, {
        token: tokens.admin,
        body: { areaId: areaY.id, title: "Web" },
      });
      assert.equal(added.status, 201);

      const grants = await sql(
        "select area_id, level from folder_areas where folder_id = $1 order by area_id",
        [project.folderId],
      );
      const byArea = Object.fromEntries(grants.map((g) => [String(g.area_id), g.level]));
      assert.equal(byArea[String(areaX.id)], "read");
      assert.equal(byArea[String(areaY.id)], "write");
    });

    test("a project without a folder gets one the first time it is opened", async () => {
      const project = await createProject();
      await sql("update projects set folder_id = null where id = $1", [project.id]);

      const res = await projectFolder(project.id, tokens.admin);
      assert.equal(res.status, 200);
      const [row] = await sql("select folder_id from projects where id = $1", [project.id]);
      assert.equal(String(row.folder_id), String(res.body.folder.id));
    });
  });

  describe("retention", () => {
    test("defaults to six months", async () => {
      const res = await server.get("/api/documents/retention", { token: tokens.owner });
      assert.equal(res.status, 200);
      assert.equal(res.body.retention.months, 6);
    });

    test("changing it needs document.manage and a positive integer", async () => {
      const put = (months, token = tokens.admin) =>
        server.put("/api/documents/retention", { token, body: { months } });

      assert.equal((await put(3, tokens.owner)).status, 403);
      for (const bad of [0, -1, 1.5, "3", true, null]) assert.equal((await put(bad)).status, 400);

      const res = await put(3);
      assert.equal(res.status, 200);
      assert.equal(res.body.retention.months, 3);
      assert.equal(String(res.body.retention.updatedBy), String(users.admin.id));
    });
  });

  describe("expiry", () => {
    const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
    const later = (months) => new Date(Date.now() + months * MONTH_MS);

    const projectWithFile = async (bytes) => {
      const project = (await server.post("/api/projects", {
        token: tokens.admin,
        body: { title: "Proyecto" },
      })).body.project;
      const file = (await upload(project.folderId, "p.bin", bytes, { token: tokens.admin })).body.file;
      return { project, file };
    };

    test("a project's folder lists with its project, and when an ended one loses its files", async () => {
      const { project } = await projectWithFile(randomBytes(32));
      const sub = (await createFolder({ parentId: project.folderId, name: "Diseño" }, tokens.admin)).body.folder;
      const listed = async () =>
        (await server.get("/api/documents/folders", { token: tokens.admin })).body.folders.find(
          (f) => f.id === project.folderId,
        ).project;

      const open = await listed();
      assert.equal(open.title, "Proyecto");
      assert.equal(open.key, project.key);
      assert.equal(open.filesExpireAt, null);

      await sql("update projects set archived_at = current_timestamp where id = $1", [project.id]);
      const [{ expected }] = await sql(
        `select archived_at + (select make_interval(months => months) from file_retention) as expected
           from projects where id = $1`,
        [project.id],
      );
      const archived = await listed();
      assert.notEqual(archived.archivedAt, null);
      assert.equal(new Date(archived.filesExpireAt).getTime(), new Date(expected).getTime());

      const inside = await server.get(`/api/documents/folders/${sub.id}`, { token: tokens.admin });
      assert.equal(inside.body.folder.project.id, project.id);
      assert.equal(new Date(inside.body.folder.project.filesExpireAt).getTime(), new Date(expected).getTime());
    });

    test("a folder outside any project has no project", async () => {
      const folder = await root();

      const res = await server.get(`/api/documents/folders/${folder.id}`, { token: tokens.owner });
      const top = await server.get("/api/documents/folders", { token: tokens.owner });

      assert.equal(res.body.folder.project, null);
      assert.equal(top.body.folders.find((f) => f.id === folder.id).project, null);
    });

    test("an open project's files never expire", async () => {
      const { file } = await projectWithFile(randomBytes(32));
      await documents.expire(later(24));
      assert.equal((await sql("select deleted_at from files where id = $1", [file.id]))[0].deleted_at, null);
    });

    test("a closed project's files expire after retention counted from the close", async () => {
      const { project, file } = await projectWithFile(randomBytes(32));
      await sql("update projects set closed_at = current_timestamp where id = $1", [project.id]);

      assert.equal((await documents.expire(later(5))).expired, 0);
      const result = await documents.expire(later(7));

      assert.equal(result.expired, 1);
      assert.equal(result.reclaimed, 1);
      assert.notEqual((await sql("select deleted_at from files where id = $1", [file.id]))[0].deleted_at, null);
      assert.equal(await statContent(file.hash), null);
      const logs = await logsFor("files", file.id);
      assert.ok(logs.some((log) => log.action === "file_expired"));
    });

    test("a loose file counts from its upload, and shared bytes stay while a live row uses them", async () => {
      const bytes = randomBytes(32);
      const loose = (await upload((await root()).id, "a.bin", bytes)).body.file;
      const { file: kept } = await projectWithFile(bytes);

      const result = await documents.expire(later(7));

      assert.equal(result.expired, 1);
      assert.equal(result.reclaimed, 0);
      assert.notEqual((await sql("select deleted_at from files where id = $1", [loose.id]))[0].deleted_at, null);
      assert.ok(await statContent(kept.hash));
    });
  });
});
