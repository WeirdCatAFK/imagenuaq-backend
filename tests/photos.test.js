// The photo service (RF-PRY-06): groups and their folios, the price catalog, payment, the photos
// bucket, and the portal that the code alone opens. Sharp makes the images, so every case stores
// real, decodable bytes.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import sharp from "sharp";

import { startServer } from "./helpers/server.js";
import { reset, resetCases, createActive, tokenFor, sql } from "./helpers/fixtures.js";
import { statContent } from "../src/access/primitives/minioStorage.js";
import { runJob } from "../src/scheduler.js";
import { normalizeCode } from "../src/access/orchestration/photos.js";

const DAY = 86_400_000;

/** A small JPEG of one colour. Different colours give different bytes. */
const image = (background) =>
  sharp({ create: { width: 96, height: 64, channels: 3, background } }).jpeg().toBuffer();

describe("/api/photos and /api/photo", () => {
  let server;
  let managerToken;
  let workerToken;

  const ACCOUNTS = ["fotografia@uaq.mx", "disenador@uaq.mx"];

  before(async () => {
    server = await startServer();
    await reset();
    await createActive({ email: ACCOUNTS[0], role: "photo_manager" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });
    managerToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await reset();
    await server.close();
  });

  beforeEach(async () => {
    await resetCases(ACCOUNTS);
  });

  const call = (method, path, body, token = managerToken) => server.request(method, path, { token, body });

  const createPackage = async (body = {}) =>
    (await call("POST", "/api/photos/packages", { name: "Digital 5", digitalCount: 5, price: 400, presalePrice: 300, ...body })).body.package;

  const createGroup = async (body = {}) => {
    const res = await call("POST", "/api/photos/groups", {
      name: "Bachiller grupo 7 2026-1",
      code: "B7",
      size: 3,
      eventStartsAt: "2026-12-10T16:00:00Z",
      eventEndsAt: "2026-12-10T20:00:00Z",
      ...body,
    });
    assert.equal(res.status, 201, res.text);
    return res.body.group;
  };

  const sheets = async (groupId) => (await call("GET", `/api/photos/groups/${groupId}/sheets`)).body.folios;

  const upload = async (folioId, kind, bytes, name = "foto.jpg") =>
    server.post(`/api/photos/folios/${folioId}/files?kind=${kind}&name=${encodeURIComponent(name)}`, {
      token: managerToken,
      raw: bytes,
      headers: { "content-type": "image/jpeg" },
    });

  /** A registered and paid folio of a fresh group, with its code. */
  const paidFolio = async (packageBody = {}) => {
    const pkg = await createPackage(packageBody);
    const group = await createGroup();
    const [sheet] = await sheets(group.id);
    await call("PUT", `/api/photo/${sheet.code}/registration`, { fullName: "Daniel Pérez", email: "daniel@example.com", packageId: pkg.id }, null);
    const paid = await call("POST", `/api/photos/folios/${sheet.id}/payment`, { cajaFolio: "CJ-1001" });
    assert.equal(paid.status, 200, paid.text);
    return { pkg, group, folio: paid.body.folio, code: sheet.code };
  };

  test("the desk is closed to a role without photo.*, open to the photo manager", async () => {
    assert.equal((await call("GET", "/api/photos/groups", undefined, workerToken)).status, 403);
    assert.equal((await call("GET", "/api/photos/groups")).status, 200);
  });

  test("a group pre-generates its folios with distinct typeable codes, a calendar event, and the configured retention", async () => {
    await call("PUT", "/api/photos/retention", { days: 45 });
    await createPackage();
    const group = await createGroup();
    assert.equal(group.size, 3);
    assert.equal(group.downloadDays, 45);
    assert.equal(group.packages.length, 1);

    const folios = (await call("GET", `/api/photos/groups/${group.id}/folios`)).body.folios;
    assert.deepEqual(folios.map((f) => f.label), ["B7-001", "B7-002", "B7-003"]);
    assert.ok(folios.every((f) => !("code" in f)), "the plain list never carries codes");

    const codes = (await sheets(group.id)).map((f) => f.code);
    assert.equal(new Set(codes).size, 3);
    for (const code of codes) assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const [event] = await sql("select title from events where id = $1", [group.eventId]);
    assert.equal(event.title, "Fotografía: Bachiller grupo 7 2026-1");

    const grown = await call("POST", `/api/photos/groups/${group.id}/folios`, { count: 2 });
    assert.equal(grown.body.folios.at(-1).label, "B7-005");
  });

  test("the group list counts the active packages a group offers, so a group with none stands out", async () => {
    const bare = await createGroup({ code: "B0" });
    const pkg = await createPackage();
    const offered = await createGroup({ code: "B1" });
    const list = async () => (await call("GET", "/api/photos/groups")).body.groups;
    const count = async (id) => (await list()).find((g) => g.id === id).activePackages;
    assert.equal(await count(bare.id), 0);
    assert.equal(await count(offered.id), 1);
    await call("PATCH", `/api/photos/packages/${pkg.id}`, { isActive: false });
    assert.equal(await count(offered.id), 0, "a retired package does not count");
  });

  test("a code opens its folio however it is typed, and a wrong one does not", async () => {
    await createPackage();
    const group = await createGroup();
    const [sheet] = await sheets(group.id);
    const messy = ` ${sheet.code.toLowerCase().replace("-", " ").replace(/0/g, "o").replace(/1/g, "l")} `;
    assert.equal(normalizeCode(messy), sheet.code.replace("-", ""));
    assert.equal(normalizeCode(`http://localhost:5173/?photo=${sheet.code}`), sheet.code.replace("-", ""));

    const res = await server.get(`/api/photo/${encodeURIComponent(messy)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.folio.label, "B7-001");
    assert.equal(res.body.folio.status, "generated");

    assert.equal((await server.get("/api/photo/ZZZZ-ZZZZ")).status, 404);
    const looked = await call("GET", `/api/photos/folios/lookup?code=${encodeURIComponent(`${server.base}/?photo=${sheet.code}`)}`);
    assert.equal(looked.body.folio.id, sheet.id);
  });

  test("payment copies the pre-sale price, and a later catalog change leaves the sale alone", async () => {
    const pkg = await createPackage();
    const group = await createGroup({ presaleUntil: new Date(Date.now() + 7 * DAY).toISOString() });
    const [first, second] = await sheets(group.id);

    const early = await call("POST", `/api/photos/folios/${first.id}/payment`, { packageId: pkg.id, cajaFolio: "CJ-1" });
    assert.equal(early.status, 400, "no name, no payment");

    const reg = await call("PUT", `/api/photo/${first.code}/registration`, { fullName: "Juan", email: "juan@example.com", packageId: pkg.id }, null);
    assert.equal(reg.body.folio.status, "registered");
    const paid = await call("POST", `/api/photos/folios/${first.id}/payment`, { cajaFolio: "CJ-1" });
    assert.equal(paid.body.folio.amount, "300.00");
    assert.equal(paid.body.folio.status, "paid");

    await call("PATCH", `/api/photos/packages/${pkg.id}`, { price: 999, presalePrice: null, name: "Digital 5 nuevo" });
    const after = (await call("GET", `/api/photos/folios/${first.id}`)).body.folio;
    assert.equal(after.amount, "300.00");
    assert.equal(after.packageName, "Digital 5");

    await call("PATCH", `/api/photos/folios/${second.id}`, { fullName: "Raya" });
    const full = await call("POST", `/api/photos/folios/${second.id}/payment`, { packageId: pkg.id, cajaFolio: "CJ-2" });
    assert.equal(full.body.folio.amount, "999.00");

    const again = await call("PUT", `/api/photo/${first.code}/registration`, { fullName: "Otro", email: "o@example.com", packageId: pkg.id }, null);
    assert.equal(again.status, 409, "the portal stops editing once paid");
  });

  test("proofs land in the photos bucket with a preview, and the client picks within the package", async () => {
    const { folio, code } = await paidFolio({ digitalCount: 1 });
    const one = await upload(folio.id, "proof", await image("#c33"));
    assert.equal(one.status, 201, one.text);
    const two = await upload(folio.id, "proof", await image("#3c3"));

    const [row] = await sql("select hash, preview_hash from photo_files where id = $1", [one.body.file.id]);
    assert.ok(await statContent(row.hash, "photos"));
    assert.ok(await statContent(row.preview_hash, "photos"));
    assert.equal(await statContent(row.hash), null, "never in the documents bucket");

    const notImage = await upload(folio.id, "proof", Buffer.from("not an image"));
    assert.equal(notImage.status, 400);

    const portal = (await server.get(`/api/photo/${code}`)).body.folio;
    assert.equal(portal.status, "proofs");
    assert.equal(portal.proofs.length, 2);

    const preview = await fetch(`${server.base}/api/photo/${code}/previews/${one.body.file.id}`);
    assert.equal(preview.status, 200);
    assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, "jpeg");

    const tooMany = await call("PUT", `/api/photo/${code}/selection`, { fileIds: [one.body.file.id, two.body.file.id] }, null);
    assert.equal(tooMany.status, 400);
    const locked = await call("PUT", `/api/photo/${code}/selection`, { fileIds: [two.body.file.id], lock: true }, null);
    assert.equal(locked.body.folio.status, "selected");
    assert.deepEqual(locked.body.folio.proofs.map((p) => p.selected), [false, true]);
    assert.equal((await call("PUT", `/api/photo/${code}/selection`, { fileIds: [] }, null)).status, 409);
  });

  test("a photo goes up in parts and comes down in byte ranges, logged once", async () => {
    const { folio, code } = await paidFolio();
    const noise = await sharp(Buffer.from(Array.from({ length: 1400 * 1400 * 3 }, () => Math.floor(Math.random() * 256))), {
      raw: { width: 1400, height: 1400, channels: 3 },
    }).png({ compressionLevel: 0 }).toBuffer();
    assert.ok(noise.length > 5 * 1024 * 1024, "big enough for two parts");

    const begin = await call("POST", `/api/photos/folios/${folio.id}/uploads`, { kind: "final", name: "grande.png", mime: "image/png" });
    assert.equal(begin.status, 201, begin.text);
    const { uploadId } = begin.body;
    const part = (n, bytes) =>
      server.put(`/api/photos/uploads/${uploadId}/${n}`, { token: managerToken, raw: bytes, headers: { "content-type": "application/octet-stream" } });
    const split = 5 * 1024 * 1024;
    assert.equal((await part(2, noise.subarray(split))).status, 400, "parts go in order");
    assert.equal((await part(1, noise.subarray(0, split))).status, 200);
    assert.equal((await part(2, noise.subarray(split))).status, 200);
    const done = await call("POST", `/api/photos/uploads/${uploadId}/complete`);
    assert.equal(done.status, 201, done.text);
    assert.equal(done.body.file.size, noise.length);
    await call("POST", `/api/photos/folios/${folio.id}/ready`);

    const url = `${server.base}/api/photo/${code}/files/${done.body.file.id}`;
    const first = await fetch(url, { headers: { range: "bytes=0-999" } });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get("content-range"), `bytes 0-999/${noise.length}`);
    assert.equal((await first.arrayBuffer()).byteLength, 1000);
    const rest = await fetch(url, { headers: { range: "bytes=1000-" } });
    assert.equal(rest.status, 206);
    const tail = Buffer.from(await rest.arrayBuffer());
    assert.ok(tail.equals(noise.subarray(1000, 1000 + tail.length)));
    const thumb = await fetch(`${server.base}/api/photo/${code}/thumbnails/${done.body.file.id}`);
    assert.equal(thumb.status, 200);
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    assert.equal(meta.format, "jpeg");
    assert.ok(meta.width <= 600 && meta.height <= 600);
    const [{ n }] = await sql("select count(*)::int as n from photo_downloads where file_id = $1", [done.body.file.id]);
    assert.equal(n, 1, "neither the second piece nor the thumbnail is a second download");

    const bad = await call("POST", `/api/photos/folios/${folio.id}/uploads`, { kind: "proof", name: "x.txt" });
    await server.put(`/api/photos/uploads/${bad.body.uploadId}/1`, { token: managerToken, raw: "not an image", headers: { "content-type": "application/octet-stream" } });
    assert.equal((await call("POST", `/api/photos/uploads/${bad.body.uploadId}/complete`)).status, 400);
  });

  test("another folio's code never reaches a photo", async () => {
    const { folio } = await paidFolio();
    const proof = await upload(folio.id, "proof", await image("#33c"));
    const [, other] = await sheets(folio.groupId);
    const res = await server.get(`/api/photo/${other.code}/previews/${proof.body.file.id}`);
    assert.equal(res.status, 404);
  });

  test("finals download within the window, are logged, follow a retention change and expire", async () => {
    const { group, folio, code } = await paidFolio();
    assert.equal((await call("POST", `/api/photos/folios/${folio.id}/ready`)).status, 409, "no finals yet");
    const final = await upload(folio.id, "final", await image("#999"), "editada.jpg");
    const ready = await call("POST", `/api/photos/folios/${folio.id}/ready`);
    assert.equal(ready.body.folio.status, "ready");

    const portal = (await server.get(`/api/photo/${code}`)).body.folio;
    assert.equal(portal.finals.length, 1);
    assert.equal(portal.daysLeft, 30);

    const got = await fetch(`${server.base}/api/photo/${code}/files/${final.body.file.id}`);
    assert.equal(got.status, 200);
    await got.arrayBuffer();
    const [{ n }] = await sql("select count(*)::int as n from photo_downloads where file_id = $1", [final.body.file.id]);
    assert.equal(n, 1);

    await call("PATCH", `/api/photos/groups/${group.id}`, { downloadDays: 5 });
    const moved = (await call("GET", `/api/photos/folios/${folio.id}`)).body.folio;
    assert.equal(Date.parse(moved.expiresAt) - Date.parse(moved.readyAt), 5 * DAY);

    const [row] = await sql("select hash from photo_files where id = $1", [final.body.file.id]);
    await runJob("photo-expiry", new Date(Date.now() + 6 * DAY));
    assert.equal(await statContent(row.hash, "photos"), null);
    const closed = await fetch(`${server.base}/api/photo/${code}/files/${final.body.file.id}`);
    assert.equal(closed.status, 404);
    assert.equal((await server.get(`/api/photo/${code}`)).body.folio.expired, true);
  });
});
