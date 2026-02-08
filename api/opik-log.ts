import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Opik } from 'opik';
import { validateRelayToken } from '../utils/relayAuth.js';
import { validatePrivacyConstraintsRecursive } from '../utils/privacy.js';

type Decision = 'triggered' | 'ignored';
type InterventionPolicy = 'focused' | 'aggressive';
type DecisionConfidence = 'high' | 'borderline' | 'low';
type DecisionReasonCode =
  | 'low_scores'
  | 'high_scores'
  | 'policy_blocked'
  | 'retrieval_bridge_used'
  | 'insufficient_concepts';

type MetadataPrimitive = string | number | boolean | null | string[];

const DecisionSchema = z.enum(['triggered', 'ignored']);
const InterventionPolicySchema = z.enum(['focused', 'aggressive']);
const DecisionConfidenceSchema = z.enum(['high', 'borderline', 'low']);
const DecisionReasonCodeSchema = z.enum([
  'low_scores',
  'high_scores',
  'policy_blocked',
  'retrieval_bridge_used',
  'insufficient_concepts',
]);

// One trace = one content item processed.
// Caller sends a high-level event which is converted into one or more spans.
const OpikLogSchema = z.object({
  trace_id: z.string().uuid(),
  event_type: z.enum(['content_evaluation', 'user_feedback']),
  content_type: z.enum(['video', 'article']).optional(),
  content_id: z.string().min(1).max(256).nullable().optional(),
  concept_count: z.number().int().nonnegative().optional(),
  relevance_score: z.number().min(0).max(1).optional(),
  learning_value_score: z.number().min(0).max(1).optional(),
  // Preferred field name for decision logs.
  system_decision: DecisionSchema.optional(),
  // Legacy alias still accepted.
  decision: DecisionSchema.optional(),
  intervention_policy: InterventionPolicySchema.optional(),
  decision_confidence: DecisionConfidenceSchema.optional(),
  retrieval_used: z.boolean().optional(),
  retrieved_count: z.number().int().nonnegative().optional(),
  agent_steps: z.array(z.string()).optional(),
  decision_reason_code: DecisionReasonCodeSchema.optional(),
  user_feedback: z.enum(['useful', 'not_useful']).nullable().optional(),
  timestamp: z.string().datetime(),
  user_id_hash: z.string().min(1).optional(),
});

type OpikLogRequest = z.infer<typeof OpikLogSchema>;

const POLICY_THRESHOLDS: Record<
  InterventionPolicy,
  {
    trigger: number;
    highRelevance: number;
    highLearning: number;
    highConceptCount: number;
    lowRelevance: number;
    lowLearning: number;
    lowConceptCount: number;
    minConceptCount: number;
  }
> = {
  focused: {
    trigger: 0.75,
    highRelevance: 0.85,
    highLearning: 0.85,
    highConceptCount: 6,
    lowRelevance: 0.65,
    lowLearning: 0.65,
    lowConceptCount: 4,
    minConceptCount: 4,
  },
  aggressive: {
    trigger: 0.6,
    highRelevance: 0.75,
    highLearning: 0.75,
    highConceptCount: 4,
    lowRelevance: 0.55,
    lowLearning: 0.55,
    lowConceptCount: 2,
    minConceptCount: 2,
  },
};

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

function sanitizeMetadata(
  data: Record<string, MetadataPrimitive | undefined>
): Record<string, MetadataPrimitive> {
  const out: Record<string, MetadataPrimitive> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'undefined') continue;
    out[key] = value;
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeDecisionConfidence(
  relevanceScore: number,
  learningValueScore: number,
  conceptCount: number,
  interventionPolicy: InterventionPolicy
): DecisionConfidence {
  const policy = POLICY_THRESHOLDS[interventionPolicy];
  if (
    relevanceScore >= policy.highRelevance &&
    learningValueScore >= policy.highLearning &&
    conceptCount >= policy.highConceptCount
  ) {
    return 'high';
  }
  if (
    relevanceScore < policy.lowRelevance ||
    learningValueScore < policy.lowLearning ||
    conceptCount < policy.lowConceptCount
  ) {
    return 'low';
  }
  return 'borderline';
}

function normalizeSystemDecision(
  explicitDecision: Decision | undefined,
  relevanceScore: number,
  learningValueScore: number,
  interventionPolicy: InterventionPolicy
): Decision {
  if (explicitDecision) return explicitDecision;
  const threshold = POLICY_THRESHOLDS[interventionPolicy].trigger;
  return relevanceScore >= threshold && learningValueScore >= threshold
    ? 'triggered'
    : 'ignored';
}

function normalizeDecisionReasonCode(args: {
  systemDecision: Decision;
  relevanceScore: number;
  learningValueScore: number;
  conceptCount: number;
  interventionPolicy: InterventionPolicy;
  retrievalUsed: boolean;
}): DecisionReasonCode {
  const {
    systemDecision,
    relevanceScore,
    learningValueScore,
    conceptCount,
    interventionPolicy,
    retrievalUsed,
  } = args;
  const policy = POLICY_THRESHOLDS[interventionPolicy];

  if (retrievalUsed && systemDecision === 'triggered') {
    return 'retrieval_bridge_used';
  }

  if (conceptCount < policy.minConceptCount) {
    return 'insufficient_concepts';
  }

  if (systemDecision === 'triggered') {
    return 'high_scores';
  }

  if (relevanceScore < policy.trigger || learningValueScore < policy.trigger) {
    return 'low_scores';
  }

  return 'policy_blocked';
}

/**
 * Send a trace + spans to Opik using the official TS SDK.
 * Privacy: never include raw content, transcript, URLs, or user PII.
 */
async function sendToOpik(data: OpikLogRequest): Promise<void> {
  const client = await getOpikClient();
  if (!client) {
    throw new Error('Opik client not configured (missing OPIK_API_KEY)');
  }

  const eventTime = new Date(data.timestamp);

  // Rich decision schema for online evaluation / experiments.
  if (data.event_type === 'content_evaluation') {
    const interventionPolicy: InterventionPolicy = data.intervention_policy ?? 'focused';
    const relevanceScore = clamp01(data.relevance_score ?? 0);
    const learningValueScore = clamp01(data.learning_value_score ?? 0);
    const conceptCount = Math.max(0, Math.floor(data.concept_count ?? 0));
    const retrievalUsed = data.retrieval_used ?? false;
    const retrievedCount = retrievalUsed ? Math.max(0, data.retrieved_count ?? 0) : 0;
    const agentSteps = Array.isArray(data.agent_steps)
      ? data.agent_steps.filter((step): step is string => typeof step === 'string')
      : [];
    const systemDecision = normalizeSystemDecision(
      data.system_decision ?? data.decision,
      relevanceScore,
      learningValueScore,
      interventionPolicy
    );
    const decisionConfidence: DecisionConfidence =
      data.decision_confidence ??
      normalizeDecisionConfidence(
        relevanceScore,
        learningValueScore,
        conceptCount,
        interventionPolicy
      );
    const decisionReasonCode: DecisionReasonCode =
      data.decision_reason_code ??
      normalizeDecisionReasonCode({
        systemDecision,
        relevanceScore,
        learningValueScore,
        conceptCount,
        interventionPolicy,
        retrievalUsed,
      });

    // Stable trace input schema: all keys always present.
    const decisionInput = {
      event_type: 'content_evaluation' as const,
      'content.type': data.content_type ?? null,
      content_id: data.content_id ?? null,
      system_decision: systemDecision,
      relevance_score: relevanceScore,
      learning_value_score: learningValueScore,
      concept_count: conceptCount,
      intervention_policy: interventionPolicy,
      decision_confidence: decisionConfidence,
      retrieval_used: retrievalUsed,
      retrieved_count: retrievedCount,
      agent_steps: agentSteps,
      decision_reason_code: decisionReasonCode,
    };

    const decisionMetadata = sanitizeMetadata({
      'signal.trace_id': data.trace_id,
      ...(data.user_id_hash ? { 'user.id.hash': data.user_id_hash } : {}),
      'event.type': 'content_evaluation',
      event_type: decisionInput.event_type,
      'content.type': decisionInput['content.type'],
      content_id: decisionInput.content_id,
      system_decision: decisionInput.system_decision,
      relevance_score: decisionInput.relevance_score,
      learning_value_score: decisionInput.learning_value_score,
      concept_count: decisionInput.concept_count,
      intervention_policy: decisionInput.intervention_policy,
      decision_confidence: decisionInput.decision_confidence,
      retrieval_used: decisionInput.retrieval_used,
      retrieved_count: decisionInput.retrieved_count,
      agent_steps: decisionInput.agent_steps,
      decision_reason_code: decisionInput.decision_reason_code,
      // Nice-to-have filter tags
      'tag.intervention_policy': `intervention_policy:${decisionInput.intervention_policy}`,
      'tag.system_decision': `system_decision:${decisionInput.system_decision}`,
      'tag.decision_confidence': `decision_confidence:${decisionInput.decision_confidence}`,
      'tag.retrieval_used': `retrieval_used:${decisionInput.retrieval_used ? 'true' : 'false'}`,
    });

    const trace = client.trace({
      name: 'signal_content_decision',
      startTime: eventTime,
      input: decisionInput,
      output: {
        system_decision: systemDecision,
        decision_reason_code: decisionReasonCode,
      },
      metadata: decisionMetadata,
    });

    const decideSpan = trace.span({
      name: 'decide_action',
      type: 'general',
      input: decisionInput,
      output: {
        system_decision: systemDecision,
        decision_reason_code: decisionReasonCode,
      },
      metadata: decisionMetadata,
    });
    decideSpan.end();

    trace.end();
    await client.flush();
    return;
  }

  // Keep non-decision event types unchanged.
  const trace = client.trace({
    name: 'signal_observability_event',
    startTime: eventTime,
    input: {
      event_type: data.event_type,
      ...(data.content_type ? { 'content.type': data.content_type } : {}),
    },
    output: {},
    metadata: sanitizeMetadata({
      'signal.trace_id': data.trace_id,
      ...(data.user_id_hash ? { 'user.id.hash': data.user_id_hash } : {}),
    }),
  });

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

  trace.end();
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
  if (!validateRelayToken(req)) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing relay token' });
    return;
  }

  try {
    // Privacy validation: recursive check for forbidden fields
    const privacyCheck = validatePrivacyConstraintsRecursive(req.body);
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

    // Content decisions are already logged from /api/analyze (score_content, decide_action,
    // generate_questions). Skip duplicate content_evaluation events arriving from clients
    // to keep one trace per content item.
    if (validatedData.event_type === 'content_evaluation') {
      res.status(200).json({ ok: true, skipped: true, reason: 'dedup_content_evaluation' });
      return;
    }

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
