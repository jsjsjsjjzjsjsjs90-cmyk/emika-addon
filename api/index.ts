import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/server.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await app.ready();

    req.url = normalizeVercelPath(req.url);

    await new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      app.server.emit('request', req, res);
    });
  } catch (error: unknown) {
    console.error('FATAL FUNCTION ERROR:', error instanceof Error ? error.message : 'unknown error');
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
  }
}

function normalizeVercelPath(url: string | undefined): string {
  const value = url || '/';
  if (value === '/api' || value === '/api/' || value === '/api/index.ts' || value === '/index') return '/';
  if (value.startsWith('/api/')) return value.slice('/api'.length) || '/';
  return value;
}
