import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/server.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await app.ready();

  // 🌟 ดักจับ Path ที่ Vercel ส่งมา แล้วบังคับให้เป็น '/' เสมอถ้าเป็นหน้าแรก
  if (req.url === '/api' || req.url === '/api/' || req.url === '/api/index.ts' || req.url === '/index') {
    req.url = '/';
  }

  // ส่ง Request ให้ Fastify ทำงาน
  await new Promise<void>((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    app.server.emit('request', req, res);
  });
}
