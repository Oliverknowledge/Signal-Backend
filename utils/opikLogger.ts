/**
 * Opik logger utility for Signal AI decisions
 * Logs analysis results as traces with spans without exposing user data.
 *
 * Privacy constraints:
 * - Never logs raw content, transcripts, goals, or questions
 * - Never logs raw user identifiers (hash only)
 */

type OpikClient = {
  trace: (args: any) => any;
  flush: () => Promise<void> | void;
};

type InterventionPolicy = 'focused' | 'aggressive';
type Decision = 'triggered' | 'ignored';
type DecisionConfidence = 'high' | 'borderline' | 'low';
type DecisionReasonCode =
  | 'low_scores'
  | 'high_scores'
  | 'policy_blocked'
  | 'retrieval_bridge_used'
  | 'insufficient_concepts';

const TRIGGER_THRESHOLDS: Record<InterventionPolicy, number> = {
  focused: 0.75,
  aggressive: 0.6,
};

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

// Opik client configuration (validated on first use)
let opikClientPromise: Promise<OpikClient | null> | null = null;

async function getOpikClient(): Promise<OpikClient | null> {
  if (opikClientPromise) return opikClientPromise;

  opikClientPromise = (async () => {
    const projectName = process.env.OPIK_PROJECT_NAME;
    const workspaceName =
      process.env.OPIK_WORKSPACE_NAME ?? process.env.OPIK_WORKSPACE;
    const apiKey = process.env.OPIK_API_KEY;
    const apiUrl =
      process.env.OPIK_URL_OVERRIDE ??
      process.env.OPIK_URL ??
      'https://www.comet.com/opik/api';

    // Log configuration status in development
    if (process.env.NODE_ENV !== 'production') {
      if (!apiKey) {
        console.warn('[Opik] OPIK_API_KEY not set - Opik logging will be skipped');
      }
      if (!projectName) {
        console.warn('[Opik] OPIK_PROJECT_NAME not set - traces may not route correctly');
      }
      if (!workspaceName) {
        console.warn('[Opik] OPIK_WORKSPACE not set - traces may not route correctly');
      }
      if (apiKey && projectName && workspaceName) {
        console.log(`[Opik] Configured: project=${projectName}, workspace=${workspaceName}`);
      }
    }

    if (!apiKey) return null;

    try {
      // Dynamic import avoids module-load crashes in serverless bundlers
      const mod: any = await import('opik');
      const OpikCtor = mod?.Opik ?? mod?.default?.Opik ?? mod?.default;
      if (!OpikCtor) {
        console.error('[Opik] Could not find Opik export in SDK package');
        return null;
      }

      // Note: docs use apiUrl/apiKey/projectName/workspaceName
      return new OpikCtor({
        apiKey,
        apiUrl,
        projectName: projectName || 'Signal',
        workspaceName,
      }) as OpikClient;
    } catch (error) {
      console.error('[Opik] Failed to initialize Opik client:', error);
      return null;
    }
  })();

  return opikClientPromise;
}

/**
 * Helper to safely get metadata object for Opik spans/traces.
 * Ensures values are serializable and flat.
 */
type MetadataValue = string | number | boolean | null | string[];

function sanitizeMetadata(
  data: Record<string, MetadataValue>
): Record<string, MetadataValue> {
  const sanitized: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(data)) {
    // Skip nested objects - Opik expects flat metadata
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      console.warn(`[Opik] Skipping nested attribute: ${key}`);
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
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
 * High-level helper for logging a full Signal analysis as a multi-span trace.
 *
 * One trace = one content item processed.
 * Spans:
 * - score_content: scoring and concept extraction (owns scores)
 * - decide_action: final decision taken (owns decision, thresholds)
 * - generate_questions: only when recall questions are generated
 */
export async function logToOpik(
  traceId: string,
  relevanceScore: number,
  learningValueScore: number,
  decision: Decision,
  conceptCount: number,
  userIdHash: string,
  contentType: 'video' | 'article',
  interventionPolicy: InterventionPolicy,
  recallQuestionCount: number,
  retrievalUsed: boolean = false,
  retrievedCount: number = 0,
  topOverlapScore: number = 0,
  overlapConceptsCount: number = 0,
  agentSteps: string[] = []
): Promise<void> {
  const opikClient = await getOpikClient();
  if (!opikClient) return;

  const normalizedRelevanceScore = clamp01(relevanceScore);
  const normalizedLearningValueScore = clamp01(learningValueScore);
  const normalizedConceptCount = Math.max(0, Math.floor(conceptCount));
  const normalizedRetrievedCount = retrievalUsed ? Math.max(0, Math.floor(retrievedCount)) : 0;
  const normalizedOverlapScore = clamp01(topOverlapScore);
  const normalizedOverlapConceptsCount = retrievalUsed
    ? Math.max(0, Math.floor(overlapConceptsCount))
    : 0;
  const normalizedAgentSteps = Array.isArray(agentSteps)
    ? agentSteps.filter((step): step is string => typeof step === 'string')
    : [];
  const triggerThreshold = TRIGGER_THRESHOLDS[interventionPolicy];
  const decisionConfidence = normalizeDecisionConfidence(
    normalizedRelevanceScore,
    normalizedLearningValueScore,
    normalizedConceptCount,
    interventionPolicy
  );
  const decisionReasonCode = normalizeDecisionReasonCode({
    systemDecision: decision,
    relevanceScore: normalizedRelevanceScore,
    learningValueScore: normalizedLearningValueScore,
    conceptCount: normalizedConceptCount,
    interventionPolicy,
    retrievalUsed,
  });
  const decisionInput = {
    event_type: 'content_evaluation' as const,
    content_type: contentType,
    'content.type': contentType,
    content_id: null as string | null,
    system_decision: decision,
    relevance_score: normalizedRelevanceScore,
    learning_value_score: normalizedLearningValueScore,
    concept_count: normalizedConceptCount,
    intervention_policy: interventionPolicy,
    decision_confidence: decisionConfidence,
    retrieval_used: retrievalUsed,
    retrieved_count: normalizedRetrievedCount,
    agent_steps: normalizedAgentSteps,
    decision_reason_code: decisionReasonCode,
  };

  try {
    // Do not set trace.id explicitly: Opik now expects UUIDv7 IDs.
    // Keep our v4 trace_id in metadata for correlation.
    const trace = opikClient.trace({
      name: 'signal_content_analysis',
      startTime: new Date(),
      input: decisionInput,
      output: {
        system_decision: decision,
        decision_reason_code: decisionReasonCode,
      },
      metadata: sanitizeMetadata({
        'signal.trace_id': traceId,
        'event.type': 'content_evaluation',
        event_type: decisionInput.event_type,
        content_type: decisionInput.content_type,
        'content.type': contentType,
        content_id: decisionInput.content_id,
        'trace.kind': 'signal_content_analysis',
        'user.id.hash': userIdHash, // Only hash, never raw user ID
        system_decision: decision,
        relevance_score: normalizedRelevanceScore,
        learning_value_score: normalizedLearningValueScore,
        concept_count: normalizedConceptCount,
        intervention_policy: interventionPolicy,
        decision_confidence: decisionConfidence,
        decision_reason_code: decisionReasonCode,
        'intervention.policy': interventionPolicy,
        'retrieval.used': retrievalUsed,
        'retrieval.count': normalizedRetrievedCount,
        'retrieval.top_overlap_score': normalizedOverlapScore,
        'retrieval.overlap_concepts_count': normalizedOverlapConceptsCount,
        retrieval_used: retrievalUsed,
        retrieved_count: normalizedRetrievedCount,
        agent_steps: normalizedAgentSteps,
        'tag.intervention_policy': `intervention_policy:${interventionPolicy}`,
        'tag.system_decision': `system_decision:${decision}`,
        'tag.decision_confidence': `decision_confidence:${decisionConfidence}`,
        'tag.retrieval_used': `retrieval_used:${retrievalUsed ? 'true' : 'false'}`,
      }),
    });

    // Core scoring / content evaluation span
    // Owns: relevance.score, learning.value.score, concept.count
    const scoreSpan = trace.span({
      name: 'score_content',
      type: 'general',
      input: {
        concept_count: normalizedConceptCount,
      },
      output: {
        relevance_score: normalizedRelevanceScore,
        learning_value_score: normalizedLearningValueScore,
      },
      metadata: sanitizeMetadata({
        'event.type': 'content_evaluation',
        event_type: 'content_evaluation',
        concept_count: normalizedConceptCount,
        relevance_score: normalizedRelevanceScore,
        learning_value_score: normalizedLearningValueScore,
        'user.id.hash': userIdHash, // Only hash, never raw user ID
        'retrieval.used': retrievalUsed,
        'retrieval.count': normalizedRetrievedCount,
        'retrieval.top_overlap_score': normalizedOverlapScore,
        'retrieval.overlap_concepts_count': normalizedOverlapConceptsCount,
        retrieval_used: retrievalUsed,
        retrieved_count: normalizedRetrievedCount,
        agent_steps: normalizedAgentSteps,
      }),
    });
    // Docs: explicitly end spans to ensure end_time is set
    scoreSpan?.end?.();

    // Decision step span
    // Owns: decision, triggered (boolean), thresholds (not raw scores)
    const decideSpan = trace.span({
      name: 'decide_action',
      type: 'general',
      input: decisionInput,
      output: {
        system_decision: decision,
        decision_reason_code: decisionReasonCode,
      },
      metadata: sanitizeMetadata({
        event_type: 'content_evaluation',
        system_decision: decision,
        relevance_score: normalizedRelevanceScore,
        learning_value_score: normalizedLearningValueScore,
        concept_count: normalizedConceptCount,
        intervention_policy: interventionPolicy,
        decision_confidence: decisionConfidence,
        retrieval_used: retrievalUsed,
        retrieved_count: normalizedRetrievedCount,
        decision_reason_code: decisionReasonCode,
        triggered: decision === 'triggered',
        'threshold.relevance': triggerThreshold,
        'threshold.learning': triggerThreshold,
        agent_steps: normalizedAgentSteps,
      }),
    });
    decideSpan?.end?.();

    // Question generation span (optional)
    if (decision === 'triggered' && recallQuestionCount > 0) {
      const qSpan = trace.span({
        name: 'generate_questions',
        type: 'general',
        input: {},
        output: {
          'questions.count': recallQuestionCount,
        },
        metadata: sanitizeMetadata({
          'questions.count': recallQuestionCount,
          'retrieval.used': retrievalUsed,
          'retrieval.count': normalizedRetrievedCount,
          'retrieval.top_overlap_score': normalizedOverlapScore,
          'retrieval.overlap_concepts_count': normalizedOverlapConceptsCount,
          retrieval_used: retrievalUsed,
          retrieved_count: normalizedRetrievedCount,
          agent_steps: normalizedAgentSteps,
        }),
      });
      qSpan?.end?.();
    }

    // End the trace (SDK handles sending automatically)
    trace.end();

    // Flush to ensure data is sent (especially important for short-lived serverless functions)
    await Promise.resolve(opikClient.flush());

    // Development-only success log
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Opik] Trace logged: ${traceId}`);
    }
  } catch (error) {
    // Log error but don't throw - logging failures shouldn't break the API
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Opik] Failed to log trace ${traceId}:`, errorMessage);
  }
}
