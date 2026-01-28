/**
 * Opik logger utility for Signal AI decisions
 * Logs analysis results as traces with spans without exposing user data.
 *
 * Privacy constraints:
 * - Never logs raw content, transcripts, goals, or questions
 * - Never logs raw user identifiers (hash only)
 */

type OpikSpanAttributes = Record<string, string | number | boolean | null>;

interface OpikSpan {
  name: 'score_content' | 'decide_action' | 'generate_questions' | 'user_feedback';
  start_time: string;
  end_time: string;
  attributes: OpikSpanAttributes;
}

interface OpikTracePayload {
  trace_id: string;
  spans: OpikSpan[];
  attributes?: OpikSpanAttributes;
  project?: string;
  workspace?: string;
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
      console.warn('[Opik] OPIK_API_KEY not set - Opik logging will be skipped');
    }
    if (!projectName) {
      console.warn('[Opik] OPIK_PROJECT_NAME not set - traces may not route correctly');
    }
    if (!workspace) {
      console.warn('[Opik] OPIK_WORKSPACE not set - traces may not route correctly');
    }
    if (apiKey && projectName && workspace) {
      console.log(`[Opik] Configured: project=${projectName}, workspace=${workspace}`);
    }
  }

  return { projectName, workspace, apiKey, opikUrl };
})();

// Timestamp tracker to ensure non-zero span durations
class SpanTimestampTracker {
  private baseTime: Date;
  private spanIndex: number = 0;

  constructor(baseTime?: Date) {
    this.baseTime = baseTime || new Date();
  }

  /**
   * Gets a start time for a span, ensuring it's offset from previous spans.
   */
  getStartTime(): string {
    const offsetMs = this.spanIndex * 2; // 2ms per span to ensure ordering
    const time = new Date(this.baseTime.getTime() + offsetMs);
    this.spanIndex++;
    return time.toISOString();
  }

  /**
   * Gets an end time for a span, ensuring it's at least 1ms after start time.
   */
  getEndTime(startTime: string): string {
    const start = new Date(startTime);
    const end = new Date(start.getTime() + Math.max(1, this.spanIndex)); // At least 1ms duration
    this.spanIndex++;
    return end.toISOString();
  }
}

/**
 * Validates that attributes are flat (no nested objects/arrays).
 */
function validateAttributes(attributes: OpikSpanAttributes): OpikSpanAttributes {
  const validated: OpikSpanAttributes = {};
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
 * Creates a new trace payload for a given trace ID with trace-level attributes.
 */
function createTrace(
  traceId: string,
  traceAttributes?: OpikSpanAttributes
): OpikTracePayload {
  const trace: OpikTracePayload = {
    trace_id: traceId,
    spans: [],
    ...(OPIK_CONFIG.projectName && { project: OPIK_CONFIG.projectName }),
    ...(OPIK_CONFIG.workspace && { workspace: OPIK_CONFIG.workspace }),
  };

  if (traceAttributes && Object.keys(traceAttributes).length > 0) {
    trace.attributes = validateAttributes(traceAttributes);
  }

  return trace;
}

/**
 * Adds a span to a trace in memory with guaranteed non-zero duration.
 * Does not perform any network I/O.
 */
function logSpan(
  trace: OpikTracePayload,
  spanName: OpikSpan['name'],
  attributes: OpikSpanAttributes,
  timestampTracker: SpanTimestampTracker
): void {
  if (!spanName || spanName.trim().length === 0) {
    console.warn('[Opik] Skipping span with empty name');
    return;
  }

  const startTime = timestampTracker.getStartTime();
  const endTime = timestampTracker.getEndTime(startTime);

  trace.spans.push({
    name: spanName,
    start_time: startTime,
    end_time: endTime,
    attributes: validateAttributes(attributes),
  });
}

/**
 * Validates trace payload before sending to Opik.
 */
function validateTracePayload(trace: OpikTracePayload): { valid: boolean; error?: string } {
  if (!trace.trace_id || trace.trace_id.trim().length === 0) {
    return { valid: false, error: 'Trace ID is required' };
  }

  if (!trace.spans || trace.spans.length === 0) {
    return { valid: false, error: 'Trace must contain at least one span' };
  }

  for (const span of trace.spans) {
    if (!span.name || span.name.trim().length === 0) {
      return { valid: false, error: 'Span name cannot be empty' };
    }
    if (!span.start_time || !span.end_time) {
      return { valid: false, error: 'Span must have start_time and end_time' };
    }
    if (new Date(span.end_time).getTime() <= new Date(span.start_time).getTime()) {
      return { valid: false, error: 'Span end_time must be after start_time' };
    }
  }

  return { valid: true };
}

/**
 * Sends a span-based trace to Opik with timeout and error logging.
 * Never throws – failures are logged but do not crash callers.
 */
async function sendTraceToOpik(trace: OpikTracePayload): Promise<void> {
  if (!OPIK_CONFIG.apiKey) {
    // Don't throw - logging failures shouldn't break the API
    return;
  }

  // Validate payload before sending
  const validation = validateTracePayload(trace);
  if (!validation.valid) {
    console.error(`[Opik] Invalid trace payload: ${validation.error}`);
    return;
  }

  try {
    const response = await fetch(`${OPIK_CONFIG.opikUrl}/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPIK_CONFIG.apiKey}`,
      },
      body: JSON.stringify(trace),
      signal: AbortSignal.timeout(5000), // 5 second timeout for logging
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[Opik] API error ${response.status}: ${errorText}`);
      // Don't throw - logging is non-critical
    } else {
      // Development-only success log
      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[Opik] Trace sent: ${trace.trace_id} (${trace.spans.length} span${trace.spans.length !== 1 ? 's' : ''})`
        );
      }
    }
  } catch (error) {
    // Log error but don't throw - logging failures shouldn't break the API
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Opik] Failed to send trace ${trace.trace_id}:`, errorMessage);
  }
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
  const timestampTracker = new SpanTimestampTracker();
  const TRIGGER_THRESHOLD = 0.7; // Signal's decision threshold

  // Create trace with trace-level attributes
  const trace = createTrace(traceId, {
    'content.type': contentType,
    'trace.kind': 'signal_content_analysis',
  });

  // Core scoring / content evaluation span
  // Owns: relevance.score, learning.value.score, concept.count
  logSpan(
    trace,
    'score_content',
    {
      'event.type': 'content_evaluation',
      'concept.count': conceptCount,
      'relevance.score': relevanceScore,
      'learning.value.score': learningValueScore,
      'user.id.hash': userIdHash, // Only hash, never raw user ID
    },
    timestampTracker
  );

  // Decision step span
  // Owns: decision, triggered (boolean), thresholds (not raw scores)
  logSpan(
    trace,
    'decide_action',
    {
      decision,
      triggered: decision === 'triggered',
      'threshold.relevance': TRIGGER_THRESHOLD,
      'threshold.learning': TRIGGER_THRESHOLD,
    },
    timestampTracker
  );

  // Question generation span (optional)
  if (decision === 'triggered' && recallQuestionCount > 0) {
    logSpan(
      trace,
      'generate_questions',
      {
        'questions.count': recallQuestionCount,
      },
      timestampTracker
    );
  }

  await sendTraceToOpik(trace);
}

