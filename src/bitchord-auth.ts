import { createHash, createPublicKey, verify } from 'node:crypto';

type JsonObject = Record<string, any>;

const AUTH_ISSUER = 'https://bitchord-auth.kushagrasingh.in';
const AUTH_AUDIENCE = 'bitchord-addons';
const JWKS_URL = `${AUTH_ISSUER}/.well-known/jwks.json`;
const SKEW_SECONDS = 60;
const PROOF_WINDOW_MS = 120_000;

let jwksCache: { expiresAt: number; keys: JsonObject[] } | undefined;
let jwksPromise: Promise<JsonObject[]> | undefined;

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64');
}

function parseJsonPart(value: string): JsonObject | undefined {
  try { return JSON.parse(decodeBase64Url(value).toString('utf8')); } catch { return undefined; }
}

async function getKeys(): Promise<JsonObject[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  if (!jwksPromise) {
    jwksPromise = fetch(JWKS_URL, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
        const body = await response.json() as JsonObject;
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (!keys.length) throw new Error('JWKS has no keys');
        jwksCache = { keys, expiresAt: Date.now() + 55 * 60_000 };
        return keys;
      })
      .finally(() => { jwksPromise = undefined; });
  }
  return jwksPromise;
}

function audienceMatches(aud: unknown): boolean {
  return Array.isArray(aud) ? aud.includes(AUTH_AUDIENCE) : aud === AUTH_AUDIENCE;
}

function validToken(token: string, nowSeconds: number): JsonObject | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const header = parseJsonPart(parts[0]);
  const payload = parseJsonPart(parts[1]);
  if (!header || !payload || header.alg !== 'EdDSA' || typeof header.kid !== 'string') return undefined;
  if (payload.iss !== AUTH_ISSUER || !audienceMatches(payload.aud)) return undefined;
  if (!Number.isFinite(payload.iat) || payload.iat > nowSeconds + SKEW_SECONDS) return undefined;
  if (!Number.isFinite(payload.exp) || payload.exp < nowSeconds - SKEW_SECONDS) return undefined;
  if (!payload.cnf?.jwk || payload.cnf.jwk.kty !== 'EC' || payload.cnf.jwk.crv !== 'P-256') return undefined;
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

function rawEcdsaToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) throw new Error('invalid ECDSA signature length');
  const integer = (part: Buffer) => {
    let value = part;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([integer(raw.subarray(0, 32)), integer(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export async function verifyBitChordRequest(
  token: string | undefined,
  proof: string | undefined,
  host: string,
  configuredHosts: Set<string>,
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!token || !proof) return { ok: false, code: 'missing' };
  const now = Date.now();
  const tokenParts = token.split('.');
  const preliminary = tokenParts.length === 3 ? parseJsonPart(tokenParts[0]) : undefined;
  let keys: JsonObject[];
  try { keys = await getKeys(); } catch { return { ok: false, code: 'unavailable' }; }
  const signingKey = keys.find((key) => key.kid === preliminary?.kid && key.kty === 'OKP' && key.crv === 'Ed25519');
  const claims = validToken(token, Math.floor(now / 1000));
  if (!signingKey || !claims) return { ok: false, code: 'invalid_token' };
  try {
    const valid = verify(null, Buffer.from(claims.signingInput), createPublicKey({ key: signingKey, format: 'jwk' }), decodeBase64Url(claims.signature));
    if (!valid) return { ok: false, code: 'invalid_token' };
  } catch { return { ok: false, code: 'invalid_token' }; }

  const match = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{86})$/.exec(proof);
  if (!match) return { ok: false, code: 'invalid_proof' };
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp - now) > PROOF_WINDOW_MS) return { ok: false, code: 'stale_proof' };
  const tokenHash = createHash('sha256').update(token).digest('base64url');
  const message = `bitchord-addon-proof/v1\n${host}\n${timestamp}\n${tokenHash}`;
  const allowedHosts = configuredHosts.size ? configuredHosts : new Set([host]);
  try {
    const jwk = claims.payload.cnf.jwk;
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const signature = rawEcdsaToDer(decodeBase64Url(match[2]));
    for (const allowed of allowedHosts) {
      if (verify('sha256', Buffer.from(`bitchord-addon-proof/v1\n${allowed}\n${timestamp}\n${tokenHash}`), key, signature)) return { ok: true };
    }
  } catch { /* invalid proof */ }
  return { ok: false, code: 'invalid_proof' };
}
