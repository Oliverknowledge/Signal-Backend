/**
 * Forbidden keys that indicate user/content data leakage.
 * Recursive scan rejects body if any of these appear at any nesting level.
 */
export const FORBIDDEN_FIELDS = [
  'raw_content',
  'content',
  'transcript',
  'transcripts',
  'user_goals',
  'goals',
  'emotional_feedback',
  'emotion',
  'user_id',
  'email',
  'name',
  'username',
  'device_id',
  'ip_address',
] as const;

const FORBIDDEN_SET = new Set(
  FORBIDDEN_FIELDS.map((f) => f.toLowerCase())
);

/**
 * Recursively scans object/array for forbidden keys.
 * Returns { valid: false, error } if any forbidden key is found at any depth.
 */
export function validatePrivacyConstraintsRecursive(
  body: unknown,
  path: string = 'body'
): { valid: boolean; error?: string } {
  if (body === null || typeof body !== 'object') {
    return { valid: true };
  }

  if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i++) {
      const result = validatePrivacyConstraintsRecursive(
        body[i],
        `${path}[${i}]`
      );
      if (!result.valid) return result;
    }
    return { valid: true };
  }

  const keys = Object.keys(body);
  for (const key of keys) {
    const keyLower = key.toLowerCase();
    if (FORBIDDEN_SET.has(keyLower)) {
      return {
        valid: false,
        error: `Request contains forbidden fields: ${key} (at ${path})`,
      };
    }
    const result = validatePrivacyConstraintsRecursive(
      (body as Record<string, unknown>)[key],
      `${path}.${key}`
    );
    if (!result.valid) return result;
  }

  return { valid: true };
}
