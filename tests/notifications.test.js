import {
  test,
  before,
  after,
  beforeEach,
  describe,
} from 'node:test';

import assert from 'node:assert/strict';
import { io as createSocketClient } from 'socket.io-client';


import { startServer } from './helpers/server.js';

import {
  reset,
  resetCases,
  createActive,
  createArea,
  tokenFor,
  sql,
} from './helpers/fixtures.js';

import notifications from '../src/access/orchestration/notifications.js';

describe('/api/notifications', () => {
    let server;
    let workerToken;
    let secondWorkerToken;
    let adminToken;

    const ACCOUNTS = [
        'notificaciones.prueba@uaq.mx',
        'notificaciones.segundo@uaq.mx',
        'notificaciones.admin@uaq.mx',
    ];

    before(async () => {
        server = await startServer();

        await reset();

        await createActive({
            email: ACCOUNTS[0],
            role: 'worker',
        });

        workerToken = await tokenFor(server, ACCOUNTS[0]);

        await createActive({
            email: ACCOUNTS[1],
            role: 'worker',
        });
        
        secondWorkerToken = await tokenFor(server, ACCOUNTS[1]);

        await createActive({
            email: ACCOUNTS[2],
            role: 'admin',
        });

        adminToken = await tokenFor(server, ACCOUNTS[2]);

    });

    after(async () => {
        try {
        await resetCases();
        await reset();
        } finally {
        await server?.close();
        }
    });

    beforeEach(async () => {
        await resetCases(ACCOUNTS);
    });

    test('rechaza consultas sin autenticación', async () => {
        const res = await server.get('/api/notifications');

        assert.equal(res.status, 401);
    });

    test('devuelve una lista vacía cuando no hay notificaciones', async () => {
        const res = await server.get('/api/notifications', {
        token: workerToken,
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.notifications, []);
    });

    test('devuelve cero notificaciones sin leer', async () => {
        const res = await server.get(
        '/api/notifications/unread-count',
        {
            token: workerToken,
        },
        );

        assert.equal(res.status, 200);
        assert.equal(res.body.unreadCount, 0);
    });

    test('permite marcar todas como leídas cuando no hay pendientes', async () => {
        const res = await server.patch(
        '/api/notifications/read-all',
        {
            token: workerToken,
        },
        );

        assert.equal(res.status, 200);
        assert.equal(res.body.updated, 0);
    });

    test('crea una notificación y la muestra en el historial', async () => {
        const [user] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[0]],
        );

        const created = await notifications.create({
            userId: user.id,
            category: 'alerta',
            type: 'proyecto',
            title: 'Proyecto actualizado',
            message: 'Se registró una actualización en tu proyecto.',
        });

        assert.ok(created.id);

        const res = await server.get('/api/notifications', {
            token: workerToken,
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.notifications.length, 1);
        assert.equal(res.body.notifications[0].title, 'Proyecto actualizado');
        assert.equal(res.body.notifications[0].isRead, false);
    });

    test('cuenta las notificaciones pendientes', async () => {
        const [user] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[0]],
        );

        await notifications.create({
            userId: user.id,
            category: 'recordatorio',
            title: 'Recordatorio de prueba',
            message: 'Tienes una actividad pendiente.',
        });

        const res = await server.get('/api/notifications/unread-count', {
            token: workerToken,
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.unreadCount, 1);
    });

    test('marca una notificación como leída', async () => {
        const [user] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[0]],
        );

        const created = await notifications.create({
            userId: user.id,
            category: 'alerta',
            title: 'Notificación de prueba',
            message: 'Esta notificación se marcará como leída.',
        });

        const res = await server.patch(
            `/api/notifications/${created.id}/read`,
            {
            token: workerToken,
            },
        );

        assert.equal(res.status, 200);
        assert.ok(res.body.notification.readAt);

        const count = await server.get('/api/notifications/unread-count', {
            token: workerToken,
        });

        assert.equal(count.body.unreadCount, 0);
    });

    test('un usuario no puede consultar las notificaciones de otro', async () => {
        const [firstUser] = await sql(
        'SELECT id FROM users WHERE email = $1',
        [ACCOUNTS[0]],
        );

        await notifications.create({
        userId: firstUser.id,
        category: 'alerta',
        title: 'Notificación privada',
        message: 'Solo el primer usuario debe verla.',
        });

        const res = await server.get('/api/notifications', {
        token: secondWorkerToken,
        });

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.notifications, []);
    });

    test('un usuario no puede marcar como leída una notificación ajena', async () => {
        const [firstUser] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[0]],
        );

        const created = await notifications.create({
            userId: firstUser.id,
            category: 'alerta',
            title: 'Aviso protegido',
            message: 'El segundo usuario no puede modificarlo.',
        });

        const res = await server.patch(
            `/api/notifications/${created.id}/read`,
            {
            token: secondWorkerToken,
            },
        );

        assert.equal(res.status, 404);

        const [stored] = await sql(
            'SELECT read_at FROM notifications WHERE id = $1',
            [created.id],
        );

        assert.equal(stored.read_at, null);
    });

    test('no crea notificaciones duplicadas con la misma dedupKey', async () => {
        const [user] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[0]],
        );

        const data = {
            userId: user.id,
            category: 'alerta',
            type: 'proyecto',
            title: 'Etapa activada',
            message: 'Se activó una etapa del proyecto.',
            dedupKey: 'test:stage_activated:123',
        };

        const first = await notifications.create(data);
        const second = await notifications.create(data);

        assert.ok(first?.id);
        assert.equal(second, null);

        const [result] = await sql(
            'SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = $1 AND dedup_key = $2',
            [user.id, data.dedupKey],
        );

        assert.equal(result.total, 1);
    });

    test('notifica al administrador cuando se activa una etapa', async () => {
        const area = await createArea('Área para notificaciones');

        const res = await server.post('/api/projects', {
            token: adminToken,
            body: {
            title: 'Proyecto de notificaciones',
            stages: [
                {
                areaId: area.id,
                title: 'Diseño gráfico',
                seq: 1,
                },
                {
                areaId: area.id,
                title: 'Producción',
                seq: 2,
                },
            ],
            },
        });

        assert.equal(res.status, 201);

        const project = res.body.project;

        assert.equal(project.stages[0].status, 'active');
        assert.equal(project.stages[1].status, 'pending');

        const notificationsRes = await server.get('/api/notifications', {
            token: adminToken,
        });

        assert.equal(notificationsRes.status, 200);

        const matching = notificationsRes.body.notifications.filter(
            (notification) =>
            notification.sourceType === 'project_stages' &&
            String(notification.sourceId) === String(project.stages[0].id),
        );

        assert.equal(matching.length, 1);
        assert.equal(matching[0].category, 'alerta');
        assert.equal(matching[0].type, 'proyecto');
        assert.equal(matching[0].title, 'Nueva etapa activada');

        assert.match(matching[0].message, /Proyecto de notificaciones/);
        assert.match(matching[0].message, /Diseño gráfico/);
    });

    test('notifica al asignado, líder y administrador sin duplicados', async () => {
        const area = await createArea('Destinatarios de notificaciones');

        const assigned = await createActive({
            email: 'asignado.notificaciones@uaq.mx',
            role: 'worker',
            area: area.name,
        });

        const leader = await createActive({
            email: 'lider.notificaciones@uaq.mx',
            role: 'area_lead',
            area: area.name,
            isAreaLeader: true,
        });

        // console.log('ASSIGNED:', assigned);
        // console.log('LEADER:', leader);
        // console.log('ASSIGNED ID:', assigned?.id);
        // console.log('LEADER ID:', leader?.id);

        const [admin] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[2]],
        );

        const [outsider] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[1]],
        );

        const res = await server.post('/api/projects', {
            token: adminToken,
            body: {
            title: 'Proyecto con destinatarios',
            stages: [
                {
                areaId: area.id,
                title: 'Diseño de materiales',
                seq: 1,
                assignedTo: assigned.id,
                },
                {
                areaId: area.id,
                title: 'Producción',
                seq: 2,
                },
            ],
            },
        });

        assert.equal(res.status, 201);

        const project = res.body.project;
        const stageId = project.stages[0].id;

        const rows = await sql(
            `SELECT user_id, title, source_id
            FROM notifications
            WHERE source_type = 'project_stages'
            AND source_id = $1
            ORDER BY user_id`,
            [stageId],
        );

        const actualRecipients = rows.map((row) => String(row.user_id)).sort();

        const expectedRecipients = [
            assigned.id,
            leader.id,
            admin.id,
        ].map(String).sort();

        assert.deepEqual(actualRecipients, expectedRecipients);

        assert.equal(rows.length, 3);

        assert.ok(
            !actualRecipients.includes(String(outsider.id)),
            'Un trabajador ajeno no debe recibir la notificación',
        );

        for (const row of rows) {
            assert.equal(row.title, 'Nueva etapa activada');
            assert.equal(String(row.source_id), String(stageId));
        }
    });

    test('no duplica avisos cuando el asignado también es líder del área', async () => {
        const area = await createArea('Área sin avisos duplicados');

        const leader = await createActive({
            email: 'lider.asignado.notificaciones@uaq.mx',
            role: 'area_lead',
            area: area.name,
            isAreaLeader: true,
        });

        const res = await server.post('/api/projects', {
            token: adminToken,
            body: {
            title: 'Proyecto sin notificaciones duplicadas',
            stages: [
                {
                areaId: area.id,
                title: 'Diseño',
                seq: 1,
                assignedTo: leader.id,
                },
            ],
            },
        });

        assert.equal(res.status, 201);

        const stageId = res.body.project.stages[0].id;

        const rows = await sql(
            `SELECT user_id
            FROM notifications
            WHERE source_type = 'project_stages'
            AND source_id = $1
            AND user_id = $2`,
            [stageId, leader.id],
        );

        assert.equal(
            rows.length,
            1,
            'El líder asignado debe recibir exactamente una notificación',
        );
    });

    test('envía notificaciones en tiempo real solo al usuario destinatario', async () => {
        const [user] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[0]],
        );

        const socketUrl = server.base;

        function connect(token) {
            return createSocketClient(socketUrl, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
            timeout: 5000,
            forceNew: true,
            });
        }

        const recipientSocket = connect(workerToken);
        const outsiderSocket = connect(secondWorkerToken);

        const receivedByRecipient = [];
        const receivedByOutsider = [];

        recipientSocket.on('notification:new', (data) => {
            receivedByRecipient.push(data);
        });

        outsiderSocket.on('notification:new', (data) => {
            receivedByOutsider.push(data);
        });

        function waitForConnection(socket) {
            return new Promise((resolve, reject) => {
            if (socket.connected) return resolve();

            socket.once('connect', resolve);
            socket.once('connect_error', reject);
            });
        }

        try {
            await Promise.all([
            waitForConnection(recipientSocket),
            waitForConnection(outsiderSocket),
            ]);

            const notification = await notifications.create({
            userId: user.id,
            category: 'alerta',
            type: 'proyecto',
            title: 'Notificación en tiempo real',
            message: 'Este aviso debe llegar únicamente al destinatario.',
            });

            assert.ok(notification?.id);

            await new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('No llegó la notificación por Socket.IO')),
                5000,
            );

            if (receivedByRecipient.length > 0) {
                clearTimeout(timeout);
                resolve();
                return;
            }

            recipientSocket.once('notification:new', () => {
                clearTimeout(timeout);
                resolve();
            });
            });

            assert.equal(receivedByRecipient.length, 1);
            assert.equal(
            receivedByRecipient[0].title,
            'Notificación en tiempo real',
            );

            assert.equal(
            String(receivedByRecipient[0].userId),
            String(user.id),
            );

            // Comprobamos que el servidor colocó cada conexión
            // en la sala privada correspondiente a su usuario.
            const [outsider] = await sql(
            'SELECT id FROM users WHERE email = $1',
            [ACCOUNTS[1]],
            );

            const recipientRoom = `user:${user.id}`;
            const outsiderRoom = `user:${outsider.id}`;

            const realtime = (await import('../src/realtime/socket.js')).default;

            assert.equal(
            realtime.io.sockets.adapter.rooms.get(recipientRoom)?.has(
                recipientSocket.id,
            ),
            true,
            );

            assert.equal(
            realtime.io.sockets.adapter.rooms.get(outsiderRoom)?.has(
                outsiderSocket.id,
            ),
            true,
            );

            assert.equal(
            realtime.io.sockets.adapter.rooms.get(recipientRoom)?.has(
                outsiderSocket.id,
            ) ?? false,
            false,
            );

            assert.equal(receivedByOutsider.length, 0);
        } finally {
            recipientSocket.disconnect();
            outsiderSocket.disconnect();
        }
    });

    test('rechaza conexiones Socket.IO sin token o con token inválido', async () => {
        async function expectRejected(token) {
            const socket = createSocketClient(server.base, {
            auth: token ? { token } : {},
            transports: ['websocket'],
            reconnection: false,
            timeout: 5000,
            forceNew: true,
            });

            try {
            const error = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                reject(new Error('La conexión no fue rechazada a tiempo'));
                }, 5000);

                socket.once('connect_error', (error) => {
                clearTimeout(timeout);
                resolve(error);
                });

                socket.once('connect', () => {
                clearTimeout(timeout);
                reject(new Error('Se permitió una conexión no autorizada'));
                });
            });

            assert.ok(error.message);
            assert.equal(socket.connected, false);
            } finally {
            socket.disconnect();
            }
        }

        await expectRejected(null);
        await expectRejected('token-invalido');
    });
});