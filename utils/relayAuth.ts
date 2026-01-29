import type { VercelRequest } from '@vercel/node';

/**
 * Validates the x-signal-relay-token header against RELAY_TOKEN env.
 * Reuse for opik-log and feedback routes.
 */
export function validateRelayToken(req: VercelRequest): boolean {
  const token = req.headers['x-signal-relay-token'];
  const expectedToken = process.env.RELAY_TOKEN;

  if (!expectedToken) {
    console.error('RELAY_TOKEN environment variable not set');
    return false;
  }

  const tokenValue = Array.isArray(token) ? token[0] : token;
  return tokenValue === expectedToken;
}
