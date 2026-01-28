  import { z } from 'zod';
  import type { VercelRequest, VercelResponse } from '@vercel/node';

  // Request schema validation
  // One trace = one content item processed.
  // Caller sends a high-level event which is converted into one or more spans.
  const OpikLogSchema = z.object({
    trace_id: z.string().uuid(),
    event_type: z.enum(['content_evaluation', 'user_feedback']),
    content_type: z.enum(['video', 'article']).optional(),
    concept_count: z.number().int().nonnegative().optional(),
    relevance_score: z.number().min(0).max(1).optional(),
    learning_value_score: z.number().min(0).max(1).optional(),
    decision: z.enum(['triggered', 'ignored']).optional(),
    user_feedback: z.enum(['useful', 'not_useful']).nullable().optional(),
    timestamp: z.string().datetime(),
    user_id_hash: z.string().min(1).optional(),
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
      FORBIDDEN_FIELDS.includes(key.toLowerCase())
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

  // Opik routing configuration (validated at module load)
  const OPIK_CONFIG = (() => {
    const projectName = process.env.OPIK_PROJECT_NAME;
    const workspace = process.env.OPIK_WORKSPACE;
    const apiKey = process.env.OPIK_API_KEY;
    const opikUrl = process.env.OPIK_URL || 'https://api.opik.ai/v1';

    // Log configuration status in development
    if (process.env.NODE_ENV !== 'production') {
      if (!apiKey) {
        console.warn('[Opik] OPIK_API_KEY not set - Opik logging will fail');
      }
      if (!projectName) {
        console.warn('[Opik] OPIK_PROJECT_NAME not set - traces may not route correctly');
      }
      if (!workspace) {
        console.warn('[Opik] OPIK_WORKSPACE not set - traces may not route correctly');
      }
    }

    return { projectName, workspace, apiKey, opikUrl };
  })();

  /**
   * Validates attributes are flat (no nested objects/arrays).
   */
  function validateAttributes(
    attributes: Record<string, string | number | boolean | null>
  ): Record<string, string | number | boolean | null> {
    const validated: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Skip nested objects - they're not supported by Opik
        console.warn(`[Opik] Skipping nested attribute: ${key}`);
        continue;
      }
      validated[key] = value;
    }
    return validated;
  }

  /**
   * Ensures non-zero span duration by offsetting timestamps.
   */
  function createSpanTimestamps(
    baseTime: Date,
    spanIndex: number
  ): { start_time: string; end_time: string } {
    const startOffsetMs = spanIndex * 2; // 2ms per span to ensure ordering
    const startTime = new Date(baseTime.getTime() + startOffsetMs);
    const endTime = new Date(startTime.getTime() + Math.max(1, spanIndex + 1)); // At least 1ms duration

    return {
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
    };
  }

  /**
   * Sends span-based trace data to Opik via REST API.
   * Converts the higher-level event payload into one or more spans.
   */
  async function sendToOpik(data: OpikLogRequest): Promise<void> {
    if (!OPIK_CONFIG.apiKey) {
      throw new Error('OPIK_API_KEY environment variable not set');
    }

    const spans: Array<{
      name: string;
      start_time: string;
      end_time: string;
      attributes: Record<string, string | number | boolean | null>;
    }> = [];

    const baseTime = new Date(data.timestamp);
    const TRIGGER_THRESHOLD = 0.7; // Signal's decision threshold
    let spanIndex = 0;

    if (data.event_type === 'content_evaluation') {
      // score_content span: owns scores and concept count
      const scoreTimestamps = createSpanTimestamps(baseTime, spanIndex++);
      spans.push({
        name: 'score_content',
        ...scoreTimestamps,
        attributes: validateAttributes({
          'event.type': data.event_type,
          ...(data.content_type && { 'content.type': data.content_type }),
          ...(typeof data.concept_count === 'number' && { 'concept.count': data.concept_count }),
          ...(typeof data.relevance_score === 'number' && { 'relevance.score': data.relevance_score }),
          ...(typeof data.learning_value_score === 'number' && {
            'learning.value.score': data.learning_value_score,
          }),
          ...(data.user_id_hash && { 'user.id.hash': data.user_id_hash }),
        }),
      });

      // decide_action span: owns decision, triggered boolean, thresholds (not raw scores)
      const decideTimestamps = createSpanTimestamps(baseTime, spanIndex++);
      spans.push({
        name: 'decide_action',
        ...decideTimestamps,
        attributes: validateAttributes({
          ...(data.decision && { decision: data.decision }),
          ...(data.decision && { triggered: data.decision === 'triggered' }),
          'threshold.relevance': TRIGGER_THRESHOLD,
          'threshold.learning': TRIGGER_THRESHOLD,
        }),
      });
    } else if (data.event_type === 'user_feedback') {
      const feedbackTimestamps = createSpanTimestamps(baseTime, spanIndex++);
      spans.push({
        name: 'user_feedback',
        ...feedbackTimestamps,
        attributes: validateAttributes({
          'event.type': data.event_type,
          ...(data.user_feedback && { 'user.feedback': data.user_feedback }),
          ...(data.user_id_hash && { 'user.id.hash': data.user_id_hash }),
        }),
      });
    }

    // Validate spans before sending
    if (spans.length === 0) {
      throw new Error('Trace must contain at least one span');
    }

    for (const span of spans) {
      if (!span.name || span.name.trim().length === 0) {
        throw new Error('Span name cannot be empty');
      }
    }

    const tracePayload = {
      trace_id: data.trace_id,
      spans,
      attributes: validateAttributes({
        ...(data.content_type && { 'content.type': data.content_type }),
        'trace.kind': 'signal_content_analysis',
      }),
      ...(OPIK_CONFIG.projectName && { project: OPIK_CONFIG.projectName }),
      ...(OPIK_CONFIG.workspace && { workspace: OPIK_CONFIG.workspace }),
    };

    const response = await fetch(`${OPIK_CONFIG.opikUrl}/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPIK_CONFIG.apiKey}`,
      },
      body: JSON.stringify(tracePayload),
      signal: AbortSignal.timeout(5000), // 5 second timeout for logging
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      const errorMessage = `Opik API error: ${response.status} ${errorText}`;
      console.error(`[Opik] ${errorMessage}`);
      throw new Error(errorMessage);
    }

    // Development-only success log
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[Opik] Trace sent: ${data.trace_id} (${spans.length} span${spans.length !== 1 ? 's' : ''})`
      );
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
