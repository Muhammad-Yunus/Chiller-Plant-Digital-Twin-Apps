import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { closePool } from './src/db/index.ts';
import { logEvent } from './src/lib/logger.ts';
import { createApp } from './src/server/app.ts';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const { app, closeActiveStreams } = createApp();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    logEvent('info', 'server_started', {
      port,
      env: process.env.NODE_ENV ?? 'development',
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('info', 'server_shutdown_initiated', { signal });

    closeActiveStreams();

    const forceExitTimer = setTimeout(() => {
      logEvent('warn', 'server_shutdown_forced', { signal });
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref?.();

    server.close(async () => {
      try {
        await closePool();
        logEvent('info', 'server_shutdown_complete', { signal });
        process.exit(0);
      } catch (err) {
        logEvent('error', 'server_shutdown_error', {
          error: err instanceof Error ? err.message : 'pool_close_failed',
        });
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

startServer().catch((err) => {
  logEvent('error', 'server_startup_failed', {
    error: err instanceof Error ? err.message : 'unknown_startup_error',
  });
  process.exit(1);
});
