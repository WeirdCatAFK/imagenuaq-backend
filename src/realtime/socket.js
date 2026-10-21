import { Server } from 'socket.io';

import auth from '../access/orchestration/auth.js';

export class Realtime {
  constructor() {
    this.io = null;
  }

  /**
   * Monta Socket.IO sobre `httpServer`. Cada conexión debe identificarse con un token válido y entra a la sala privada de su usuario.
   *
   * @throws {Error} si ya estaba iniciado.
   */
  start(httpServer, corsOrigin = '*') {
    if (this.io) {
      throw new Error('Socket.IO is already initialized.');
    }

    this.io = new Server(httpServer, { cors: { origin: corsOrigin } });

    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== 'string' || !token.trim()) {
          return next(new Error('Authentication required.'));
        }
        socket.data.user = await auth.verifyToken(token.trim());
        next();
      } catch {
        next(new Error('Invalid or expired token.'));
      }
    });

    this.io.on('connection', (socket) => {
      socket.join(`user:${socket.data.user.id}`);
    });

    return this.io;
  }

  /** Envía `event` a las conexiones abiertas de `userId`; no hace nada antes de start(). */
  sendToUser(userId, event, data) {
    if (!this.io) return;
    this.io.to(`user:${userId}`).emit(event, data);
  }

  /** Cierra todas las conexiones; evita procesos colgados o que las pruebas fallen por puertos retenidos. */
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
