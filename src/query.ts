import { badRequest } from './errors.js';

export function normalizeHealthQuery(value: string | undefined, maxLength: number): string {
  const query = (value ?? 'love').trim();
  if (!query) return 'love';
  if (query.length > maxLength) throw badRequest(`q must be at most ${maxLength} characters`);
  return query;
}
