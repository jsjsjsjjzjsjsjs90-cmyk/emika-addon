# Integration audit evidence — 2026-11-02

## Scope

ตรวจ Emika Addon เทียบกับ BitChord, LastWave Native, hifi-api, Eclipse Music และ Mornye Extension โดยยึดโค้ด client/เอกสารที่เข้าถึงได้เป็นหลัก และทดสอบโค้ด Emika ใน local รวมถึง smoke test production.

## Protocol findings

- BitChord ใช้ `GET /manifest.json`, `GET /search?q=...` และ `GET /stream/{id}`; response เป็น JSON และ track ต้องมี `id` กับ `title` ที่ไม่ว่าง
- LastWave Native ใช้ endpoint เดียวกัน และรองรับ quality `atmos`, `hi_res`, `lossless`, `high`, `low` พร้อม `atmos=auto|none`
- LastWave มี native User-Agent หลักคือ `LastWave-Player/1.0` และ `LastWave-Downloader/1.0`; Emika รองรับสองรูปแบบนี้ รวมถึง `LastWave/<version>` และ `BitChord/<version>`
- BitChord ใช้ `sampleRate` เป็น Hz และ `bitDepth` เป็นจำนวนบิต; Emika ไม่เติมค่าที่ไม่มีหลักฐานและคงค่า 96/192 kHz กับ 24-bit ไว้
- BitChord/LastWave ไม่มี download endpoint แยก การดาวน์โหลดใช้ stream resolution เดิม โดย `allowDownloads` เป็น policy ใน manifest
- แหล่งข้อมูลที่ตรวจไม่พบข้อกำหนดบังคับเรื่อง Range/206 สำหรับ addon protocol แต่ Emika media proxy ยังคงรองรับและส่งต่อ `Range`, `Content-Range` และ `Accept-Ranges` สำหรับ browser playback
- hifi-api และ Mornye มีพฤติกรรมเฉพาะของ Tidal/segmented downloads ไม่ควรถูกนำมาบังคับใช้กับ Qobuz/Instable โดยตรง

## Fixes applied

1. เพิ่ม `LastWave-Player` และ `LastWave-Downloader` ใน User-Agent gate/direct-stream routing
2. ปรับ rate limiter ให้ใช้ client IP ตัวแรกจาก `x-forwarded-for` ที่ Vercel ส่งผ่าน เพื่อไม่รวมผู้ใช้หลายคนเป็น bucket เดียวกัน
3. เพิ่ม `Range` ใน CORS allow-list และ expose headers ที่ audio player ใช้ตรวจสอบการตอบกลับ
4. ลบ delay หลัง retry ครั้งสุดท้ายของ Instable ลดเวลารอเมื่อ retry หมดแล้ว
5. เพิ่ม regression tests สำหรับ forwarded client key, LastWave aliases และ Config routing
6. เพิ่ม Hi-Res ใน static `manifest.json` ให้ตรงกับ dynamic manifest
7. คง media proxy สำหรับ browser/download และ direct upstream URL สำหรับ BitChord/LastWave ตามค่า routing config

## Verification

- Unit tests: 56 ผ่าน, 0 ล้มเหลว
- TypeScript build: ผ่าน
- `git diff --check`: ผ่าน
- Local gate test: `LastWave-Player/1.0`, `LastWave-Downloader/1.0`, `LastWave/1.0` ได้ HTTP 200; UA ทั่วไปได้ HTTP 403 เมื่อเปิด gate
- Production ก่อน deployment ชุดนี้: search BitChord และ LastWave ได้ HTTP 200; production ยังแสดง `X-RateLimit-Limit: 60` เพราะยังเป็น deployment ก่อนแก้

## Remaining limitations

- Rate limiter ยังเป็น in-memory ต่อ serverless instance จึงไม่ใช้ quota กลางทั้งระบบ หากต้องการ global quota ต้องใช้ external store เช่น Redis/KV
- Media proxy ส่งผ่านไฟล์ต้นฉบับและไม่ฝังปกอัลบั้มลง FLAC เพราะการ tag ระหว่าง streaming จะทำลาย Range/seek และอาจทำให้ไฟล์เสียหาย การแสดงปกทำผ่าน `artworkURL` ใน metadata/UI
- อายุ signed upstream URL ยังขึ้นกับ Instable; หากหมดอายุให้เรียก `/stream` ใหม่ ไม่ควร cache URL ต้นทางถาวร

## Sources

- BitChord docs: https://bitchord.kushagrasingh.in/docs
- BitChord repository: https://github.com/kushagrasinghx/BitChord.git
- LastWave Native: https://github.com/Clash-Projects/LastWave-Native.git
- hifi-api: https://github.com/binimum/hifi-api
- Eclipse Music addon guide: https://eclipsemusic.app/
- Mornye docs/repository: https://mornye.com/docs and https://github.com/mornyeapp/Mornye-Extension.git

## Vercel production log audit

หลังเชื่อมทีม Vercel พบว่าในช่วง 30 นาทีล่าสุดมี runtime records ระดับ info 200 รายการ และไม่พบ runtime error/fatal/warning ที่ถูกบันทึกโดย logger. Request records มี 200 จำนวน 166 รายการ, 206 จำนวน 2 รายการ, 404 จำนวน 15 รายการ, 502 จำนวน 1 รายการ และ 500 จำนวน 5 รายการ. กลุ่ม 404 เป็น media request ซ้ำของ stream ที่หมดอายุหรือหา rendition ไม่ได้ ส่วน 502 เป็น stream ที่ใช้เวลา 6 วินาทีจน upstream ไม่พร้อมใช้งาน. กลุ่ม 500 ของ search ใช้เวลาประมาณ 3.5–5 วินาทีและตรงกับ source timeout.

แก้แล้วโดยเปลี่ยน timeout ภายในจาก generic HTTP 500 เป็น `504 upstream service timeout` เพื่อให้ BitChord/LastWave แยก upstream timeout ออกจาก server bug ได้ถูกต้อง การแก้ไขนี้ผ่าน unit tests และ TypeScript build แล้ว และต้องรอ production deployment ใหม่ก่อนตรวจ status code ใน Vercel logs อีกครั้ง.

## Final production verification after environment update

หลังปรับ Production Environment Variables และ redeploy แล้ว BitChord `BitChord/v1.9` และ LastWave `LastWave-Player/1.0` ค้นหาได้ HTTP 200 และคืนผลลัพธ์ 10 tracks. ทั้งสอง client เรียก `/stream/:id` ได้ HTTP 200 พร้อม `format=flac`, `quality=HI_RES` และ direct upstream URL. Browser flow ได้ `/media/:id` ตามที่ออกแบบไว้ และ Range request ได้ HTTP 206 พร้อม `Content-Range`, `Content-Length`, `Accept-Ranges` และชื่อไฟล์ `Final Client Audit.flac`.

การตรวจ input ผิดรูปแบบได้ผลตามสัญญา: quality ที่ไม่รู้จักตอบ HTTP 400 และ track ID ที่ผิดรูปแบบตอบ HTTP 404. Logs ช่วงหลัง smoke test พบ request 200 จำนวน 1 รายการและไม่พบ 4xx/5xx หรือ runtime error ใหม่. Unit tests ยังคงผ่าน 56/56 และ TypeScript build ผ่าน.

## Multi-method audit: Deplexo sources — 2026-11-03

ตรวจเพิ่มแบบแยกหน่วยกับ Eljohnzc Deplexo, BitChord Hi-Res Deplexo, BitChord repository, LastWave Native, hifi-api และ Eclipse Music. หลักฐานที่ยืนยันได้คือทั้งสอง Deplexo source รองรับ `GET /manifest.json`, `GET /search?q=...` และ `GET /stream/{id}` แต่รายละเอียดต่างกัน: Eljohnzc ส่ง MPEG-DASH/FLAC-in-MP4 และ tokenized external media URLs; BitChord Hi-Res ส่ง FLAC signed URLs และมีกรณี `dz:` ที่ response ระบุ provider เป็น Qobuz จึงต้องถือว่า provider identity ยังไม่น่าเชื่อถือเต็มที่.

เพิ่ม source identity `bitchordhires` และ route แยก `/g`; เปลี่ยนค่าเริ่มต้นของ Eljohnzc และ BitChord Hi-Res ไปยัง Deplexo URLs ใหม่. เพิ่ม `EMIKA_ROOT_SOURCES` เพื่อให้ root addon ใช้เฉพาะ Instable ต่อไป ขณะที่ source ใหม่เปิดได้เฉพาะ isolated routes เมื่ออยู่ใน `QOBUZ_ENABLED_SOURCES`. เพิ่ม `REMOTE_ADDON_TIMEOUT_MS` สำหรับ isolated remote search ที่ช้ากว่า Instable. การดาวน์โหลดของ source ใหม่ไม่เปิดเป็นค่าเริ่มต้นจนกว่าจะมีการยืนยันสิทธิ์และ policy ของ upstream.

ผล local integration: `/e/manifest.json` และ `/g/manifest.json` ตอบ HTTP 200; source ใหม่ทั้งสองค้นหาได้เมื่อเปิดใน `QOBUZ_ENABLED_SOURCES`; root search ยังคงแยกใช้ root source policy. Contract ที่ยึดใช้คือ HTTPS, JSON, URL-encoded path/query, `encrypted=false`, metadata ตาม stream จริง และไม่เก็บ signed URL/token ถาวร.

ผล multi-method สรุปว่า wire contract สามารถนำมาทำ adapter ได้ แต่ยังไม่ควรอ้างว่า source ใหม่มีสิทธิ์ดาวน์โหลดหรือรองรับ Hi-Res ทุกเพลงจาก label เพียงอย่างเดียว. Eclipse ใช้เป็น reference ด้าน addon contract เท่านั้น ไม่ได้ยืนยันว่าเป็น audio source ของ Emika. hifi-api ใช้เป็น reference ด้าน capability-based metadata/expiry/error handling ไม่ได้นำโค้ดหรือ credential มาใช้.

## Download capability verification — 2026-11-03

Production ทดสอบ `/download/:id` ของ source ใหม่ทั้งสองแล้ว: BitChord Hi-Res ส่ง `audio/flac` จริง รองรับ `206 Range` และตั้งชื่อไฟล์ `.flac` ถูกต้อง. Eljohnzc ส่ง `application/dash+xml` เป็น MPEG-DASH manifest (`.mpd/.dash`) ไม่ใช่ไฟล์เสียงเดี่ยว แม้ดาวน์โหลดได้ก็จะเป็น manifest ที่เปิดฟังแบบไฟล์ FLAC ไม่ได้ จึงตั้ง `EMIKA_DOWNLOAD_SOURCES=instable,bitchordhires` และคง Eljohnzc เป็น playback-only แทนการปลอมชื่อไฟล์หรือประกอบ segment ใน serverless proxy.
