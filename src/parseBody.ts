export interface HttpLikeEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
}

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; raw: string; reason: string };

/** Never throws. A body that can't be parsed is data to dead-letter, not an exception. */
export function parseBody(ev: HttpLikeEvent): ParseResult {
  let text = ev.body ?? '';
  try {
    if (ev.isBase64Encoded && text) text = Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return { ok: false, raw: String(ev.body), reason: 'invalid base64' };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { ok: false, raw: text, reason: 'empty body' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, raw: text, reason: `invalid JSON: ${(e as Error).message}` };
  }
}
