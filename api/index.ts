import type { IncomingMessage, ServerResponse } from 'node:http';
import { app } from '../src/server.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 1. รอให้ Fastify พร้อม (ไม่ต้องเก็บใส่ตัวแปรแล้ว)
  await app.ready();

  // 2. รอให้ Response ส่งข้อมูลเสร็จก่อน ค่อยจบฟังก์ชัน (แก้ปัญหาค้างบน Vercel)
  await new Promise<void>((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    app.server.emit('request', req, res);
  });
}
