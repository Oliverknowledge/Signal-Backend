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
function sanitizeMetadata(
  data: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> {
  const sanitized: Record<string, string | number | boolean | null> = {};
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
  decision: 'triggered' | 'ignored',
  conceptCount: number,
  userIdHash: string,
  contentType: 'video' | 'article',
  recallQuestionCount: number
): Promise<void> {
  const opikClient = await getOpikClient();
  if (!opikClient) return;

  const TRIGGER_THRESHOLD = 0.7; // Signal's decision threshold

  try {
    // Create trace using Opik SDK
    const trace = opikClient.trace({
      name: 'signal_content_analysis',
      input: {
        'content.type': contentType,
        'trace.kind': 'signal_content_analysis',
      },
      output: {
        decision,
        'relevance.score': relevanceScore,
        'learning.value.score': learningValueScore,
      },
      metadata: sanitizeMetadata({
        'signal.trace_id': traceId,
        'content.type': contentType,
        'trace.kind': 'signal_content_analysis',
        'user.id.hash': userIdHash, // Only hash, never raw user ID
      }),
    });

    // Core scoring / content evaluation span
    // Owns: relevance.score, learning.value.score, concept.count
    const scoreSpan = trace.span({
      name: 'score_content',
      type: 'general',
      input: {
        'concept.count': conceptCount,
      },
      output: {
        'relevance.score': relevanceScore,
        'learning.value.score': learningValueScore,
      },
      metadata: sanitizeMetadata({
        'event.type': 'content_evaluation',
        'concept.count': conceptCount,
        'relevance.score': relevanceScore,
        'learning.value.score': learningValueScore,
        'user.id.hash': userIdHash, // Only hash, never raw user ID
      }),
    });
    // Docs: explicitly end spans to ensure end_time is set
    scoreSpan?.end?.();

    // Decision step span
    // Owns: decision, triggered (boolean), thresholds (not raw scores)
    const decideSpan = trace.span({
      name: 'decide_action',
      type: 'general',
      input: {
        'relevance.score': relevanceScore,
        'learning.value.score': learningValueScore,
      },
      output: {
        decision,
        triggered: decision === 'triggered',
      },
      metadata: sanitizeMetadata({
        decision,
        triggered: decision === 'triggered',
        'threshold.relevance': TRIGGER_THRESHOLD,
        'threshold.learning': TRIGGER_THRESHOLD,
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

