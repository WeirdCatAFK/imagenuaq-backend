// The scheduled jobs in src/scheduler.js, run through runJob() with a fixed clock. The jobs that
// notify are checked for who hears and for writing nothing on a second run.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';

import { startServer } from './helpers/server.js';
import { reset, resetCases, createActive, createArea, tokenFor, sql } from './helpers/fixtures.js';
import { JOBS, runJob } from '../src/scheduler.js';

const ADMIN = 'admin.agenda@uaq.mx';

/** The notifications a user holds whose dedup key starts with `prefix`. */
const notificationsOf = (userId, prefix) =>
  sql('select * from notifications where user_id = $1 and dedup_key like $2 order by id', [
    userId,
    `${prefix}%`,
  ]);

describe('scheduled jobs', () => {
  let server;
  let admin;
  let adminToken;

  before(async () => {
    server = await startServer();
    await reset();
    admin = await createActive({ email: ADMIN, role: 'admin' });
    adminToken = await tokenFor(server, ADMIN);
  });

  after(async () => {
    try {
      await resetCases();
      await reset();
    } finally {
      await server?.close();
    }
  });

  beforeEach(() => resetCases([ADMIN]));

  test('every job has a unique name and a valid schedule', () => {
    const names = JOBS.map((job) => job.name);
    assert.equal(new Set(names).size, names.length);
    for (const job of JOBS) assert.ok(cron.validate(job.schedule), job.name);
  });

  test('an unknown job name is refused', async () => {
    await assert.rejects(runJob('no-such-job'), /Unknown job/);
  });

  describe('birthdays', () => {
    test('tells everyone, greets the person, and writes nothing on a second run', async () => {
      const born = await createActive({ email: 'cumple@uaq.mx', fullName: 'Ana Cumple' });
      const other = await createActive({ email: 'otro@uaq.mx' });
      await sql(`update users set birthday = '1990-10-21' where id = $1`, [born.id]);

      const now = new Date('2026-10-21T15:00:00Z');
      const first = await runJob('birthdays', now);
      const second = await runJob('birthdays', now);

      const [{ live }] = await sql('select count(*)::int as live from users where deleted_at is null');
      assert.equal(first.notified, live);
      assert.equal(second.notified, 0);

      const [greeting] = await notificationsOf(born.id, 'birthday:');
      assert.equal(greeting.title, '¡Feliz cumpleaños!');
      const [heads] = await notificationsOf(other.id, 'birthday:');
      assert.match(heads.message, /Ana Cumple/);
      assert.equal(heads.type, 'birthday');
    });

    test('counts the day in Querétaro time, not UTC', async () => {
      const born = await createActive({ email: 'cumple@uaq.mx' });
      await sql(`update users set birthday = '1990-10-21' where id = $1`, [born.id]);

      const lateEvening = new Date('2026-10-22T04:00:00Z');
      assert.ok((await runJob('birthdays', lateEvening)).notified > 0);
    });

    test('a 29 February birthday is told on the 28th only in common years', async () => {
      const born = await createActive({ email: 'bisiesto@uaq.mx' });
      await sql(`update users set birthday = '2000-02-29' where id = $1`, [born.id]);

      assert.ok((await runJob('birthdays', new Date('2027-02-28T18:00:00Z'))).notified > 0);
      assert.equal((await runJob('birthdays', new Date('2028-02-28T18:00:00Z'))).notified, 0);
      assert.ok((await runJob('birthdays', new Date('2028-02-29T18:00:00Z'))).notified > 0);
    });

    test('a deleted user is neither told nor celebrated', async () => {
      const born = await createActive({ email: 'cumple@uaq.mx' });
      await sql(`update users set birthday = '1990-10-21', deleted_at = now() where id = $1`, [born.id]);

      assert.equal((await runJob('birthdays', new Date('2026-10-21T15:00:00Z'))).notified, 0);
    });
  });

  describe('file-expiry-warning', () => {
    /** A project closed `closedAt`, with one stage in `areaId` and `files` live files in its folder. */
    async function closedProject(areaId, closedAt, files = 1) {
      const res = await server.post('/api/projects', {
        token: adminToken,
        body: { title: 'Proyecto por expirar', stages: [{ areaId, title: 'Diseño', seq: 1 }] },
      });
      assert.equal(res.status, 201);
      const project = res.body.project;

      const [folder] = await sql(
        `insert into folders (name, owner_id) values ($1, $2) returning id`,
        [`carpeta-${project.id}`, admin.id],
      );
      for (let i = 0; i < files; i++) {
        await sql(
          `insert into files (folder_id, author_id, hash, name, size) values ($1, $2, $3, $4, 1)`,
          [folder.id, admin.id, String(i).padStart(64, 'a'), `archivo-${i}.pdf`],
        );
      }
      await sql('update projects set folder_id = $2, closed_at = $3::timestamptz where id = $1', [
        project.id,
        folder.id,
        closedAt,
      ]);
      return project;
    }

    test('warns the area leads and the admins once, a week ahead', async () => {
      const area = await createArea('Expiración de archivos');
      const lead = await createActive({
        email: 'lider.archivos@uaq.mx',
        role: 'area_lead',
        area: area.name,
        isAreaLeader: true,
      });
      const worker = await createActive({ email: 'trabajador.archivos@uaq.mx', area: area.name });

      const now = new Date('2026-10-21T15:00:00Z');
      const project = await closedProject(area.id, '2026-04-24T15:00:00Z', 2);

      const first = await runJob('file-expiry-warning', now);
      const second = await runJob('file-expiry-warning', now);
      assert.equal(first.notified, 2);
      assert.equal(second.notified, 0);

      const [toLead] = await notificationsOf(lead.id, `file-expiry-warning:${project.id}:`);
      assert.match(toLead.message, /^2 archivo\(s\) del proyecto /);
      assert.match(toLead.message, /24\/10\/2026/);
      assert.equal((await notificationsOf(admin.id, 'file-expiry-warning:')).length, 1);
      assert.equal((await notificationsOf(worker.id, 'file-expiry-warning:')).length, 0);
    });

    test('says nothing for a project further out, or one with no live files', async () => {
      const area = await createArea('Expiración lejana');
      await closedProject(area.id, '2026-05-10T15:00:00Z');
      await closedProject(area.id, '2026-04-24T15:00:00Z', 0);

      assert.equal((await runJob('file-expiry-warning', new Date('2026-10-21T15:00:00Z'))).notified, 0);
    });
  });

  describe('finance-gaps', () => {
    test('tells finance the counts and each lead their projects, once every three days', async () => {
      const area = await createArea('Pendientes de finanzas');
      const lead = await createActive({
        email: 'lider.finanzas@uaq.mx',
        role: 'area_lead',
        area: area.name,
        isAreaLeader: true,
      });
      const worker = await createActive({ email: 'trabajador.finanzas@uaq.mx', area: area.name });
      const money = await createActive({ email: 'finanzas@uaq.mx', role: 'finance' });

      const create = async (body) => {
        const res = await server.post('/api/projects', {
          token: adminToken,
          body: { stages: [{ areaId: area.id, title: 'Diseño', seq: 1 }], ...body },
        });
        assert.equal(res.status, 201);
        return res.body.project;
      };
      const costed = await create({ title: 'Con costo', key: 'GAP-COSTO', hasCost: true });
      await create({ title: 'Sin costo', key: 'GAP-NADA' });
      const archived = await create({ title: 'Archivado', key: 'GAP-ARCH', hasCost: true });
      await sql('update projects set archived_at = now() where id = $1', [archived.id]);

      const now = new Date('2026-10-26T15:00:00Z');
      const first = await runJob('finance-gaps', now);
      assert.ok(first.notified >= 3);
      assert.equal((await runJob('finance-gaps', now)).notified, 0);
      const later = await runJob('finance-gaps', new Date('2026-10-29T15:00:00Z'));
      assert.equal(later.notified, first.notified);

      const [toMoney] = await notificationsOf(money.id, 'finance-gaps:finance:');
      assert.match(toMoney.message, /^1 proyecto\(s\) con pendientes de finanzas: 0 con facturas faltantes, 1 con costo y sin cotización/);
      assert.equal((await notificationsOf(admin.id, 'finance-gaps:finance:')).length, 2);

      const [toLead] = await notificationsOf(lead.id, 'finance-gaps:lead:');
      assert.match(toLead.message, new RegExp(`: ${costed.key}\\. Sube`));
      assert.equal((await notificationsOf(worker.id, 'finance-gaps:')).length, 0);
    });

    test('says nothing when no project has a gap', async () => {
      assert.equal((await runJob('finance-gaps', new Date('2026-10-26T15:00:00Z'))).notified, 0);
    });
  });

  test('notifications-cleanup deletes only notifications older than six months', async () => {
    const insert = (createdAt) =>
      sql(
        `insert into notifications (user_id, category, title, message, created_at)
         values ($1, 'alerta', 'Prueba', 'Prueba', $2)`,
        [admin.id, createdAt],
      );
    await insert(new Date(Date.now() - 200 * 24 * 60 * 60 * 1000));
    await insert(new Date());

    assert.deepEqual(await runJob('notifications-cleanup'), { deleted: 1 });
    const [{ remaining }] = await sql('select count(*)::int as remaining from notifications where user_id = $1', [
      admin.id,
    ]);
    assert.equal(remaining, 1);
  });
});
