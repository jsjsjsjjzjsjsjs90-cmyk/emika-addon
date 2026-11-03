import { badRequest } from './errors.js';

export function normalizeHealthQuery(value: string | undefined, maxLength: number): string {
  const query = (value ?? 'vegas doja cat').trim();
  if (!query) return 'vegas doja cat';
  if (query.length > maxLength) throw badRequest(`q must be at most ${maxLength} characters`);
  return query;
}
