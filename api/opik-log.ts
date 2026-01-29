  import { z } from 'zod';
  import type { VercelRequest, VercelResponse } from '@vercel/node';
  import { Opik } from 'opik';

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

  let opikClientPromise: Promise<Opik | null> | null = null;

  async function getOpikClient(): Promise<Opik | null> {
    if (opikClientPromise) return opikClientPromise;

    opikClientPromise = (async () => {
      const apiKey = process.env.OPIK_API_KEY;
      const projectName = process.env.OPIK_PROJECT_NAME;
      const workspaceName =
        process.env.OPIK_WORKSPACE_NAME ?? process.env.OPIK_WORKSPACE;
      const apiUrl =
        process.env.OPIK_URL_OVERRIDE ??
        process.env.OPIK_URL ??
        'https://www.comet.com/opik/api';

      if (!apiKey) return null;

      try {
        return new Opik({
          apiKey,
          apiUrl,
          projectName: projectName || 'Signal',
          workspaceName,
        });
      } catch (e) {
        console.error('[Opik] Failed to initialize client:', e);
        return null;
      }
    })();

    return opikClientPromise;
  }

  /**
   * Send a trace + spans to Opik using the official TS SDK.
   */
  async function sendToOpik(data: OpikLogRequest): Promise<void> {
    const client = await getOpikClient();
    if (!client) {
      throw new Error('Opik client not configured (missing OPIK_API_KEY)');
    }

    const TRIGGER_THRESHOLD = 0.7;

    const trace = client.trace({
      name: 'signal_observability_event',
      input: {
        event_type: data.event_type,
        ...(data.content_type ? { 'content.type': data.content_type } : {}),
      },
      output: {},
      metadata: {
        'signal.trace_id': data.trace_id,
        ...(data.user_id_hash ? { 'user.id.hash': data.user_id_hash } : {}),
      },
    });

    if (data.event_type === 'content_evaluation') {
      const scoreSpan = trace.span({
        name: 'score_content',
        type: 'general',
        input: {
          ...(typeof data.concept_count === 'number'
            ? { 'concept.count': data.concept_count }
            : {}),
        },
        output: {
          ...(typeof data.relevance_score === 'number'
            ? { 'relevance.score': data.relevance_score }
            : {}),
          ...(typeof data.learning_value_score === 'number'
            ? { 'learning.value.score': data.learning_value_score }
            : {}),
        },
        metadata: {
          'event.type': data.event_type,
          ...(data.content_type ? { 'content.type': data.content_type } : {}),
        },
      });
      scoreSpan.end();

      const decideSpan = trace.span({
        name: 'decide_action',
        type: 'general',
        input: {
          ...(typeof data.relevance_score === 'number'
            ? { 'relevance.score': data.relevance_score }
            : {}),
          ...(typeof data.learning_value_score === 'number'
            ? { 'learning.value.score': data.learning_value_score }
            : {}),
        },
        output: {
          ...(data.decision ? { decision: data.decision } : {}),
          ...(data.decision ? { triggered: data.decision === 'triggered' } : {}),
        },
        metadata: {
          'threshold.relevance': TRIGGER_THRESHOLD,
          'threshold.learning': TRIGGER_THRESHOLD,
        },
      });
      decideSpan.end();
    }

    if (data.event_type === 'user_feedback') {
      const feedbackSpan = trace.span({
        name: 'user_feedback',
        type: 'general',
        input: {},
        output: {
          ...(data.user_feedback ? { 'user.feedback': data.user_feedback } : {}),
        },
        metadata: {
          'event.type': data.event_type,
        },
      });
      feedbackSpan.end();
    }

    trace.end();

    // Serverless-safe: ensure upload before function exits.
    await client.flush();
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

      // Send to Opik (awaited): this endpoint exists purely for logging, so reliability matters.
      await sendToOpik(validatedData);

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
