import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/server.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await app.ready();

    // ดักจับ Path ที่ Vercel ส่งมา
    if (req.url === '/api' || req.url === '/api/' || req.url === '/api/index.ts' || req.url === '/index') {
      req.url = '/';
    }

    await new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      app.server.emit('request', req, res);
    });
  } catch (error: any) {
    console.error('FATAL FUNCTION ERROR:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ 
        error: 'Function crashed', 
        message: error.message || String(error),
        stack: error.stack 
      }));
    }
  }
}
