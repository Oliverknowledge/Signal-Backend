/**
 * POST /api/recall
 * Receives recall session metrics (trace_id, content_id, recall_correct, recall_total).
 * Does not store raw answers; logs to Opik for learning quality signals.
 */

import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateRelayToken } from '../utils/relayAuth.js';
import { validatePrivacyConstraintsRecursive } from '../utils/privacy.js';
import { Opik } from 'opik';

const RecallSchema = z.object({
  trace_id: z.string().uuid(),
  content_id: z.string().min(1),
  recall_correct: z.number().int().min(0),
  recall_total: z.number().int().min(1),
}).refine(
  (data) => data.recall_correct <= data.recall_total,
  { message: 'recall_correct must be <= recall_total' }
);

type RecallRequest = z.infer<typeof RecallSchema>;

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
      console.error('[Opik] Recall init failed:', e);
      return null;
    }
  })();
  return opikClientPromise;
}

async function logRecallToOpik(data: RecallRequest): Promise<void> {
  const client = await getOpikClient();
  if (!client) return;

  const recallRatio = data.recall_total > 0 ? data.recall_correct / data.recall_total : 0;

  try {
    // Do not set trace.id explicitly: Opik expects UUIDv7 IDs.
    // Keep signal.trace_id metadata for correlation.
    const trace = client.trace({
      name: 'signal_content_analysis',
      startTime: new Date(),
      input: {
        'event.type': 'recall_completed',
        'content.id': data.content_id,
        'recall.correct': data.recall_correct,
        'recall.total': data.recall_total,
        'recall.ratio': recallRatio,
      },
      output: {},
      metadata: {
        'signal.trace_id': data.trace_id,
        'event.type': 'recall_completed',
        'content.id': data.content_id,
        'recall.correct': data.recall_correct,
        'recall.total': data.recall_total,
        'recall.ratio': recallRatio,
      },
    });

    const span = trace.span({
      name: 'recall_completed',
      type: 'general',
      startTime: new Date(),
      input: {
        'event.type': 'recall_completed',
        'content.id': data.content_id,
        'recall.correct': data.recall_correct,
        'recall.total': data.recall_total,
        'recall.ratio': recallRatio,
      },
      output: {},
      metadata: {
        'event.type': 'recall_completed',
        'content.id': data.content_id,
        'recall.correct': data.recall_correct,
        'recall.total': data.recall_total,
        'recall.ratio': recallRatio,
      },
    });
    span.end();
    trace.end();
    await client.flush();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Opik] Recall span log failed:', msg);
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

  const parseResult = RecallSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Invalid request schema',
      details: parseResult.error.errors,
    });
    return;
  }

  const data = parseResult.data;

  void logRecallToOpik(data);

  res.status(200).json({ ok: true });
}
