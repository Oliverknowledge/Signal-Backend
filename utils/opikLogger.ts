/**
 * Opik logger utility for Signal AI decisions
 * Logs analysis results without exposing user data
 */

/**
 * Logs an AI decision trace to Opik
 * Only sends scores, decision, concept count, and user_id_hash (as attribute)
 * Never sends content, transcripts, goals, or questions
 */
export async function logToOpik(
  traceId: string,
  relevanceScore: number,
  learningValueScore: number,
  decision: 'triggered' | 'ignored',
  conceptCount: number,
  userIdHash: string,
  contentType: 'video' | 'article'
): Promise<void> {
  const apiKey = process.env.OPIK_API_KEY;
  const opikUrl = process.env.OPIK_URL || 'https://api.opik.ai/v1';
  const projectName = process.env.OPIK_PROJECT_NAME;
  const workspace = process.env.OPIK_WORKSPACE;

  if (!apiKey) {
    // Don't throw - logging failures shouldn't break the API
    console.error('OPIK_API_KEY not set, skipping Opik logging');
    return;
  }

  const tracePayload = {
    trace_id: traceId,
    name: 'signal.content_evaluation',
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    attributes: {
      'event.type': 'content_evaluation',
      'content.type': contentType,
      'concept.count': conceptCount,
      'relevance.score': relevanceScore,
      'learning.value.score': learningValueScore,
      'decision': decision,
      'user.id.hash': userIdHash, // Only hash, never raw user ID
    },
    ...(projectName && { project: projectName }),
    ...(workspace && { workspace }),
  };

  try {
    const response = await fetch(`${opikUrl}/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(tracePayload),
      signal: AbortSignal.timeout(5000), // 5 second timeout for logging
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`Opik API error: ${response.status} ${errorText}`);
      // Don't throw - logging is non-critical
    }
  } catch (error) {
    // Log error but don't throw - logging failures shouldn't break the API
    console.error('Failed to send trace to Opik:', error instanceof Error ? error.message : 'Unknown error');
  }
}
