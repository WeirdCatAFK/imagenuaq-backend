import { Server } from 'socket.io';


import auth from '../access/orchestration/auth.js';

export class Realtime {
    constructor() {
        this.io = null;
    }

    start(httpServer, corsOrigin = '*') {
        if (this.io) {
            throw new Error('Socket.IO is already initialized.');
        }

        this.io = new Server(httpServer, {
            cors: {
            origin: corsOrigin,
            },
        });

        // Cada conexión debe identificarse con un token válido.
        this.io.use(async (socket, next) => {
            try {
                const token = socket.handshake.auth?.token;

                if (typeof token !== 'string' || !token.trim()) {
                    return next(new Error('Authentication required.'));
                }

                const user = await auth.verifyToken(token.trim());

                socket.data.user = user;

                next();
            } catch {
                next(new Error('Invalid or expired token.'));
            }
        });

        this.io.on('connection', (socket) => {
            const userId = socket.data.user.id;

            // Sala privada del usuario autenticado.
            socket.join(`user:${userId}`);
        });

        return this.io;
    }

    sendToUser(userId, event, data) {
        if (!this.io) return;

        this.io.to(`user:${userId}`).emit(event, data);
    }
    
    //evita procesos cogados o que las pruebas automatizadas fallen por puertos retenidos
    async stop() {
        if (!this.io) return;

        const io = this.io;
        this.io = null;

        await new Promise((resolve) => {
            io.close(resolve);
        });
    }
}

export default new Realtime();