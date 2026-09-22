import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./helpers/server.js";
import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  logsFor,
  roleId,
} from "./helpers/fixtures.js";

describe("/api/statuses", () => {
  let server;
  let adminToken;
  let workerToken;

  const ACCOUNTS = ["coordinacion@uaq.mx", "disenador@uaq.mx"];

  // Seeded by projects-spine, plus `rechazada` from status-manage.
  const GLOBAL = [
    "recibido",
    "en_proceso",
    "esperando_vb",
    "en_produccion",
    "enviado",
    "entregado",
    "rechazada",
    "cerrado",
  ];

  before(async () => {
    server = await startServer();
    await reset();

    await createActive({ email: ACCOUNTS[0], role: "admin" });
    await createActive({ email: ACCOUNTS[1], role: "worker" });

    adminToken = await tokenFor(server, ACCOUNTS[0]);
    workerToken = await tokenFor(server, ACCOUNTS[1]);
  });

  after(async () => {
    await grantWorker([]);
    await resetCases();
    await reset();
    await server.close();
  });

  beforeEach(() => resetCases(ACCOUNTS));

  async function grantWorker(permissions) {
    const res = await server.put(
      `/api/roles/${await roleId("worker")}/permissions`,
      {
        token: adminToken,
        body: { permissions },
      },
    );
    assert.equal(res.status, 200);
  }

  const create = (body, token = adminToken) =>
    server.post("/api/statuses", { token, body });

  describe("GET /", () => {
    test("lists the global catalogue, in sort order, to any session", async () => {
      const res = await server.get("/api/statuses", { token: workerToken });

      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.statuses.map((s) => s.code),
        GLOBAL,
      );
      assert.ok(res.body.statuses.every((s) => s.isGlobal === true));
      // RF-EST-05 reads these: the two outcomes that end a project.
      assert.deepEqual(
        res.body.statuses.filter((s) => s.isTerminal).map((s) => s.code),
        ["rechazada", "cerrado"],
      );
    });

    test("with an area, the area rows come after the global ones", async () => {
      const area = await createArea("Serigrafía");
      const made = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa",
        sortOrder: 25,
      });
      assert.equal(made.status, 201);

      const res = await server.get(`/api/statuses?areaId=${area.id}`, {
        token: workerToken,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(
        res.body.statuses.map((s) => s.code),
        [...GLOBAL, "en_prensa"],
      );

      const own = res.body.statuses.at(-1);
      assert.equal(own.areaId, area.id);
      assert.equal(own.areaName, area.name);
      assert.equal(own.isGlobal, false);

      // Another area does not see it.
      const other = await createArea("Otra área");
      const isolated = await server.get(`/api/statuses?areaId=${other.id}`, {
        token: workerToken,
      });
      assert.deepEqual(
        isolated.body.statuses.map((s) => s.code),
        GLOBAL,
      );
    });

    test("a bad areaId is a 400", async () => {
      assert.equal(
        (await server.get("/api/statuses?areaId=cero", { token: workerToken }))
          .status,
        400,
      );
    });
  });

  describe("POST /", () => {
    test("an area may reuse a global code", async () => {
      // Two partial unique indexes, not one on the pair: NULL is distinct from NULL.
      const area = await createArea("Diseño de prueba");
      const res = await create({
        areaId: area.id,
        code: "recibido",
        label: "Recibido en el área",
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.status.code, "recibido");
      assert.equal(res.body.status.areaId, area.id);
    });

    test("the same code twice in one area is a 409", async () => {
      const area = await createArea("Repetidos");
      assert.equal(
        (
          await create({
            areaId: area.id,
            code: "en_prensa",
            label: "En prensa",
          })
        ).status,
        201,
      );

      const again = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa otra vez",
      });
      assert.equal(again.status, 409);
      assert.equal(
        again.body.error.message,
        "That catalogue already has a status with that code.",
      );
    });

    test("a global code twice is a 409", async () => {
      const again = await create({
        code: "cerrado",
        label: "Cerrado otra vez",
      });
      assert.equal(again.status, 409);
    });

    test("normalises the code and defaults sortOrder and isTerminal", async () => {
      const area = await createArea("Normaliza");
      const res = await create({
        areaId: area.id,
        code: "  EN_REVISION  ",
        label: "En revisión",
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.status.code, "en_revision");
      assert.equal(res.body.status.sortOrder, 0);
      assert.equal(res.body.status.isTerminal, false);
      assert.equal(res.body.status.isActive, true);
    });

    const BAD = [
      ["a code with spaces", { code: "en prensa", label: "X" }, /snake_case/],
      [
        "a code starting with a digit",
        { code: "1ero", label: "X" },
        /snake_case/,
      ],
      ["no label", { code: "sin_etiqueta" }, /label is required/],
      [
        "a non-integer sortOrder",
        { code: "x", label: "X", sortOrder: 1.5 },
        /sortOrder must be an integer/,
      ],
      [
        "a non-boolean isTerminal",
        { code: "x", label: "X", isTerminal: "si" },
        /isTerminal must be a boolean/,
      ],
    ];

    for (const [label, body, message] of BAD) {
      test(`refuses ${label}`, async () => {
        const res = await create(body);
        assert.equal(res.status, 400);
        assert.match(res.body.error.message, message);
      });
    }

    test("an unknown area is a 400, not a 500", async () => {
      const res = await create({
        areaId: 999999,
        code: "fantasma",
        label: "Fantasma",
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.message, "That area does not exist.");
    });
  });

  describe("PATCH /:id and DELETE /:id", () => {
    test("edits the label, order and terminal flag, and writes the trail", async () => {
      const area = await createArea("Editables");
      const made = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa",
      });
      const id = made.body.status.id;

      const res = await server.patch(`/api/statuses/${id}`, {
        token: adminToken,
        body: { label: "En la prensa", sortOrder: 45, isTerminal: true },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.status.label, "En la prensa");
      assert.equal(res.body.status.sortOrder, 45);
      assert.equal(res.body.status.isTerminal, true);
      assert.equal(
        res.body.status.code,
        "en_prensa",
        "the code is not editable",
      );

      const logs = await logsFor("statuses", id);
      assert.deepEqual(
        logs.map((l) => l.action),
        ["record_created", "record_updated"],
      );
    });

    test("a code or areaId in the body is ignored", async () => {
      const area = await createArea("Inmutables");
      const made = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa",
      });

      const res = await server.patch(`/api/statuses/${made.body.status.id}`, {
        token: adminToken,
        body: { label: "Otro", code: "otro_codigo", areaId: null },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.status.code, "en_prensa");
      assert.equal(res.body.status.areaId, area.id);
    });

    test("deactivating hides it from the list unless includeInactive", async () => {
      const area = await createArea("Desactivables");
      const made = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa",
      });
      const id = made.body.status.id;

      assert.equal(
        (await server.delete(`/api/statuses/${id}`, { token: adminToken }))
          .status,
        200,
      );

      const hidden = await server.get(`/api/statuses?areaId=${area.id}`, {
        token: adminToken,
      });
      assert.ok(!hidden.body.statuses.some((s) => s.id === id));

      const shown = await server.get(
        `/api/statuses?areaId=${area.id}&includeInactive=true`,
        { token: adminToken },
      );
      const found = shown.body.statuses.find((s) => s.id === id);
      assert.equal(found.isActive, false);

      // The row is still readable by id: requests and projects reference it.
      assert.equal(
        (await server.get(`/api/statuses/${id}`, { token: adminToken })).status,
        200,
      );
      assert.equal(
        (await server.delete(`/api/statuses/${id}`, { token: adminToken }))
          .status,
        409,
      );
    });

    test("reactivates through the patch", async () => {
      const area = await createArea("Reactivables");
      const made = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa",
      });
      await server.delete(`/api/statuses/${made.body.status.id}`, {
        token: adminToken,
      });

      const res = await server.patch(`/api/statuses/${made.body.status.id}`, {
        token: adminToken,
        body: { isActive: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status.isActive, true);
    });

    test("refuses an empty patch and 404s on a missing status", async () => {
      const area = await createArea("Vacíos");
      const made = await create({
        areaId: area.id,
        code: "en_prensa",
        label: "En prensa",
      });

      assert.equal(
        (
          await server.patch(`/api/statuses/${made.body.status.id}`, {
            token: adminToken,
            body: {},
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await server.patch("/api/statuses/999999", {
            token: adminToken,
            body: { label: "X" },
          })
        ).status,
        404,
      );
      assert.equal(
        (await server.delete("/api/statuses/999999", { token: adminToken }))
          .status,
        404,
      );
      assert.equal(
        (await server.get("/api/statuses/999999", { token: adminToken }))
          .status,
        404,
      );
    });
  });

  describe("permissions", () => {
    test("reads need only a session, writes need status.manage", async () => {
      assert.equal(
        (await server.get("/api/statuses", { token: workerToken })).status,
        200,
      );
      assert.equal(
        (await create({ code: "del_trabajador", label: "X" }, workerToken))
          .status,
        403,
      );

      await grantWorker(["status.manage"]);
      try {
        const area = await createArea("Con permiso");
        const res = await create(
          { areaId: area.id, code: "del_trabajador", label: "X" },
          workerToken,
        );
        assert.equal(res.status, 201);
      } finally {
        await grantWorker([]);
      }
    });

    test("no token is a 401", async () => {
      assert.equal((await server.get("/api/statuses")).status, 401);
    });
  });

  describe("byCode", () => {
    test("resolves the default a new request starts at", async () => {
      const { default: statuses } =
        await import("../src/access/orchestration/statuses.js");

      const received = await statuses.byCode("recibido");
      assert.equal(received.code, "recibido");
      assert.equal(received.areaId, null);

      assert.equal(await statuses.byCode("no_existe"), null);
    });
  });
});
