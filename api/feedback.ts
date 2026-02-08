import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Opik } from 'opik';
import { validateRelayToken } from '../utils/relayAuth.js';
import { validatePrivacyConstraintsRecursive } from '../utils/privacy.js';
import {
  persistFeedback,
  type StoredFeedback,
  ALLOWED_FEEDBACK_REASONS,
} from '../utils/feedbackStore.js';

// Allowed structured reason codes only (no free text)
const allowedReasonSet = new Set(ALLOWED_FEEDBACK_REASONS);
const reasonSchema = z
  .string()
  .refine((r) => allowedReasonSet.has(r as (typeof ALLOWED_FEEDBACK_REASONS)[number]));

// --- Request schema (Zod) ---
const FeedbackSchema = z
  .object({
    trace_id: z.string().uuid(),
    content_id: z.string().min(1),
    feedback: z.enum(['useful', 'not_useful']),
    recall_correct: z.number().int().min(0).optional(),
    recall_total: z.number().int().min(1).optional(),
    reasons: z.array(reasonSchema).max(10).optional(),
    timestamp: z.string().datetime(),
  })
  .refine(
    (data) => {
      if (data.recall_total != null && data.recall_correct != null) {
        return data.recall_correct <= data.recall_total;
      }
      return true;
    },
    { message: 'recall_correct must be <= recall_total' }
  );

type FeedbackRequest = z.infer<typeof FeedbackSchema>;

// --- Opik client (same pattern as opik-log) ---
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
 * Send user_feedback span to Opik. Uses SDK trace + span; correlation via signal.trace_id.
 * Logs API errors server-side only; does not throw to client.
 */
async function logFeedbackToOpik(data: FeedbackRequest): Promise<void> {
  const client = await getOpikClient();
  if (!client) return;

  const startTime = new Date(data.timestamp);

  const recallCorrect = data.recall_correct;
  const recallTotal = data.recall_total;
  const recallRatio =
    recallTotal != null && recallTotal > 0 && recallCorrect != null
      ? recallCorrect / recallTotal
      : undefined;

  const reasonsPayload =
    data.reasons != null && data.reasons.length > 0
      ? { 'feedback.reasons': data.reasons.join(',') }
      : {};

  try {
    // Do not set trace.id explicitly: Opik expects UUIDv7 IDs.
    // Keep signal.trace_id metadata for correlation.
    const trace = client.trace({
      name: 'signal_content_analysis',
      startTime: startTime,
      input: {
        'event.type': 'user_feedback',
        feedback: data.feedback,
        'content.id': data.content_id,
        ...(recallCorrect != null && { 'recall.correct': recallCorrect }),
        ...(recallTotal != null && { 'recall.total': recallTotal }),
        ...(recallRatio != null && { 'recall.ratio': recallRatio }),
        ...reasonsPayload,
        'trace.kind': 'signal_content_analysis',
      },
      output: {},
      metadata: {
        'signal.trace_id': data.trace_id,
        'event.type': 'user_feedback',
        feedback: data.feedback,
        'content.id': data.content_id,
        ...(recallCorrect != null && { 'recall.correct': recallCorrect }),
        ...(recallTotal != null && { 'recall.total': recallTotal }),
        ...(recallRatio != null && { 'recall.ratio': recallRatio }),
        ...reasonsPayload,
        'trace.kind': 'signal_content_analysis',
      },
    });

    const span = trace.span({
      name: 'user_feedback',
      type: 'general',
      startTime: startTime,
      input: {
        'event.type': 'user_feedback',
        feedback: data.feedback,
        'content.id': data.content_id,
        ...(recallCorrect != null && { 'recall.correct': recallCorrect }),
        ...(recallTotal != null && { 'recall.total': recallTotal }),
        ...(recallRatio != null && { 'recall.ratio': recallRatio }),
        ...reasonsPayload,
        'trace.kind': 'signal_content_analysis',
      },
      output: {},
      metadata: {
        'event.type': 'user_feedback',
        feedback: data.feedback,
        'content.id': data.content_id,
        ...(recallCorrect != null && { 'recall.correct': recallCorrect }),
        ...(recallTotal != null && { 'recall.total': recallTotal }),
        ...(recallRatio != null && { 'recall.ratio': recallRatio }),
        ...reasonsPayload,
        'trace.kind': 'signal_content_analysis',
      },
    });
    span.end();
    trace.end();
    await client.flush();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Opik] Feedback span log failed:', msg);
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!validateRelayToken(req)) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing relay token' });
    return;
  }

  const privacyCheck = validatePrivacyConstraintsRecursive(req.body);
  if (!privacyCheck.valid) {
    res.status(400).json({ error: privacyCheck.error });
    return;
  }

  const parseResult = FeedbackSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Invalid request schema',
      details: parseResult.error.errors,
    });
    return;
  }

  const data = parseResult.data;

  const entry: StoredFeedback = {
    trace_id: data.trace_id,
    content_id: data.content_id,
    feedback: data.feedback,
    ...(data.recall_correct != null && { recall_correct: data.recall_correct }),
    ...(data.recall_total != null && { recall_total: data.recall_total }),
    ...(data.reasons != null && data.reasons.length > 0 && { reasons: data.reasons }),
    timestamp: data.timestamp,
  };
  persistFeedback(entry);

  void logFeedbackToOpik(data);

  res.status(200).json({ ok: true });
}
