import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Request schema validation
const OpikLogSchema = z.object({
  trace_id: z.string().uuid(),
  event_type: z.enum(['content_evaluation', 'user_feedback']),
  content_type: z.enum(['video', 'article']),
  concept_count: z.number().int().nonnegative(),
  relevance_score: z.number().min(0).max(1),
  learning_value_score: z.number().min(0).max(1),
  decision: z.enum(['triggered', 'ignored']),
  user_feedback: z.enum(['useful', 'not_useful']).nullable(),
  timestamp: z.string().datetime(),
});

type OpikLogRequest = z.infer<typeof OpikLogSchema>;

// Forbidden fields that indicate user data leakage
const FORBIDDEN_FIELDS = [
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
];

/**
 * Validates that the request body doesn't contain forbidden user data fields
 */
function validatePrivacyConstraints(body: unknown): { valid: boolean; error?: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: true };
  }

  const keys = Object.keys(body);
  const forbiddenFound = keys.filter((key) =>
    FORBIDDEN_FIELDS.some((forbidden) =>
      key.toLowerCase().includes(forbidden.toLowerCase())
    )
  );

  if (forbiddenFound.length > 0) {
    return {
      valid: false,
      error: `Request contains forbidden fields: ${forbiddenFound.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Validates the security token header
 */
function validateSecurityToken(req: VercelRequest): boolean {
  const token = req.headers['x-signal-relay-token'];
  const expectedToken = process.env.RELAY_TOKEN;

  if (!expectedToken) {
    console.error('RELAY_TOKEN environment variable not set');
    return false;
  }

  const tokenValue = Array.isArray(token) ? token[0] : token;
  return tokenValue === expectedToken;
}

/**
 * Sends trace data to Opik via REST API
 */
async function sendToOpik(data: OpikLogRequest): Promise<void> {
  const apiKey = process.env.OPIK_API_KEY;
  const opikUrl = process.env.OPIK_URL || 'https://api.opik.ai/v1';
  const projectName = process.env.OPIK_PROJECT_NAME;
  const workspace = process.env.OPIK_WORKSPACE;

  if (!apiKey) {
    throw new Error('OPIK_API_KEY environment variable not set');
  }

  // Construct Opik trace payload
  const tracePayload = {
    trace_id: data.trace_id,
    name: `signal.${data.event_type}`,
    start_time: new Date(data.timestamp).toISOString(),
    end_time: new Date().toISOString(),
    attributes: {
      'event.type': data.event_type,
      'content.type': data.content_type,
      'concept.count': data.concept_count,
      'relevance.score': data.relevance_score,
      'learning.value.score': data.learning_value_score,
      'decision': data.decision,
      ...(data.user_feedback && { 'user.feedback': data.user_feedback }),
    },
    ...(projectName && { project: projectName }),
    ...(workspace && { workspace }),
  };

  const response = await fetch(`${opikUrl}/traces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(tracePayload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Opik API error: ${response.status} ${errorText}`);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Validate security token
  if (!validateSecurityToken(req)) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing relay token' });
    return;
  }

  try {
    // Privacy validation: check for forbidden fields
    const privacyCheck = validatePrivacyConstraints(req.body);
    if (!privacyCheck.valid) {
      res.status(400).json({ error: privacyCheck.error });
      return;
    }

    // Validate request schema
    const validationResult = OpikLogSchema.safeParse(req.body);
    if (!validationResult.success) {
      res.status(400).json({
        error: 'Invalid request schema',
        details: validationResult.error.errors,
      });
      return;
    }

    const validatedData = validationResult.data;

    // Send to Opik (async, don't block response)
    sendToOpik(validatedData).catch((error) => {
      // Log error server-side only (not in response)
      console.error('Failed to send trace to Opik:', error.message);
    });

    // Return success immediately
    res.status(200).json({ ok: true });
  } catch (error) {
    // Generic error handling - don't expose internal details
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';

    // Only log in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('Request processing error:', errorMessage);
    }

    res.status(500).json({ error: 'Internal server error' });
  }
}
