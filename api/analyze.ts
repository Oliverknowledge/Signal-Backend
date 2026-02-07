/**
 * Signal AI Decision Endpoint
 * POST /api/analyze
 * 
 * Core AI decision endpoint that analyzes content, extracts concepts,
 * scores relevance/learning value, and generates recall questions.
 */

import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'crypto';
import { fetchContent } from '../utils/contentFetcher.js';
import { analyzeContent, generateBridgeQuestion, type LearningMode } from '../utils/openaiClient.js';
import { logToOpik } from '../utils/opikLogger.js';

function normalizeLearningMode(value?: string): LearningMode {
  if (!value) return 'general_learning';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');

  if (normalized === 'interview_prep' || normalized === 'interview') return 'interview_prep';
  if (
    normalized === 'assessment_exam_prep' ||
    normalized === 'assessment_prep' ||
    normalized === 'assessment' ||
    normalized === 'exam_prep' ||
    normalized === 'examprep' ||
    normalized === 'exam'
  ) return 'assessment_exam_prep';
  if (normalized === 'general_learning' || normalized === 'general' || normalized === 'casual') {
    return 'general_learning';
  }
  if (normalized === 'deep_focus' || normalized === 'deepfocus') return 'interview_prep';
  return 'general_learning';
}

// Request schema validation
const LibraryDigestItemSchema = z.object({
  content_id: z.string().min(1),
  title: z.string().min(1),
  concepts: z.array(z.string()),
  created_at: z.number().int().nonnegative(),
});

const AnalyzeRequestSchema = z.object({
  content_url: z.string().url(),
  user_id_hash: z.string().min(1),
  goal_id: z.string().min(1),
  goal_description: z.string().min(1),
  intervention_policy: z.enum(['focused', 'aggressive']).default('focused'),
  learning_mode: z.string().optional(),
  known_concepts: z.array(z.string()).default([]),
  weak_concepts: z.array(z.string()).default([]),
  library_digest: z.array(LibraryDigestItemSchema).optional(),
});

type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;
type LibraryDigestItem = z.infer<typeof LibraryDigestItemSchema>;

type NormalizedDigestItem = {
  contentId: string;
  title: string;
  concepts: string[];
  createdAt: number;
};

type RetrievalCandidate = NormalizedDigestItem & {
  overlapConcepts: string[];
  overlapScore: number;
};

/**
 * Determines content type from URL
 */
function getContentType(url: string): 'video' | 'article' {
  const youtubePattern = /(?:youtube\.com|youtu\.be)/;
  return youtubePattern.test(url) ? 'video' : 'article';
}

function normalizeLibraryDigest(items?: LibraryDigestItem[]): NormalizedDigestItem[] {
  if (!items || items.length === 0) return [];
  return items
    .slice(0, 100)
    .map((item) => ({
      contentId: item.content_id.trim(),
      title: item.title.trim().slice(0, 80),
      concepts: item.concepts
        .filter((c) => typeof c === 'string')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .slice(0, 12),
      createdAt: Number.isFinite(item.created_at) ? item.created_at : 0,
    }))
    .filter((item) => item.contentId.length > 0 && item.title.length > 0 && item.concepts.length > 0);
}

function computeRetrievalCandidates(
  newConcepts: string[],
  digest: NormalizedDigestItem[]
): RetrievalCandidate[] {
  if (newConcepts.length === 0 || digest.length === 0) return [];

  const newConceptSet = new Set(newConcepts.map((c) => c.trim().toLowerCase()).filter(Boolean));
  const newConceptCount = newConceptSet.size;
  if (newConceptCount === 0) return [];
  const candidates: RetrievalCandidate[] = [];

  for (const item of digest) {
    const overlap = new Set<string>();
    for (const concept of item.concepts) {
      const key = concept.trim().toLowerCase();
      if (key && newConceptSet.has(key)) {
        overlap.add(concept);
      }
    }
    const overlapScore = overlap.size;
    const overlapRatio = overlapScore / newConceptCount;
    if (overlapScore >= 2 && overlapRatio >= 0.25) {
      candidates.push({
        ...item,
        overlapConcepts: Array.from(overlap),
        overlapScore,
      });
    }
  }

  return candidates
    .sort((a, b) => {
      if (b.overlapScore !== a.overlapScore) return b.overlapScore - a.overlapScore;
      return b.createdAt - a.createdAt;
    })
    .slice(0, 2);
}

function applyBridgeQuestion(
  questions: Array<
    | { type: 'open'; question: string }
    | { type: 'mcq'; question: string; options: string[]; correct_index: number }
  >,
  bridge: { type: 'open'; question: string }
) {
  const updated = questions.slice();
  const openIndex = updated.findIndex((q) => q.type === 'open');
  if (openIndex >= 0) {
    updated[openIndex] = bridge;
    return updated;
  }
  if (updated.length > 0) {
    updated[0] = bridge;
    return updated;
  }
  return [bridge];
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

  try {
    // Validate request schema
    const validationResult = AnalyzeRequestSchema.safeParse(req.body);
    if (!validationResult.success) {
      res.status(400).json({
        error: 'Invalid request schema',
        details: validationResult.error.errors,
      });
      return;
    }

    const {
      content_url,
      user_id_hash,
      goal_id,
      goal_description,
      intervention_policy,
      learning_mode,
      known_concepts,
      weak_concepts,
      library_digest,
    } = validationResult.data;
    const normalizedLearningMode = normalizeLearningMode(learning_mode);

    // Generate trace ID for this analysis
    const traceId = randomUUID();

    // Step 1: Fetch content (with timeout)
    let content: string;
    try {
      content = await Promise.race([
        fetchContent(content_url),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Content fetch timeout')), 30000)
        ),
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to fetch content';
      res.status(400).json({
        error: 'Content fetch failed',
        message: errorMessage,
      });
      return;
    }

    if (!content || content.trim().length === 0) {
      res.status(400).json({
        error: 'No content extracted from URL',
      });
      return;
    }

    // Step 2: Analyze content with OpenAI (with timeout)
    let analysisResult;
    try {
      analysisResult = await Promise.race([
        analyzeContent(
          content,
          goal_description,
          known_concepts,
          weak_concepts,
          intervention_policy,
          normalizedLearningMode
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Analysis timeout')), 60000)
        ),
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'AI analysis failed';
      console.error('OpenAI analysis error:', errorMessage);
      res.status(500).json({
        error: 'AI analysis failed',
        message: errorMessage,
      });
      return;
    }

    // Optional: lightweight retrieval from client-provided library digest (no embeddings).
    const normalizedDigest = normalizeLibraryDigest(library_digest);
    const retrievalCandidates = computeRetrievalCandidates(analysisResult.concepts, normalizedDigest);

    let retrievalUsed = false;
    let relatedItems: Array<{
      content_id: string;
      title: string;
      overlap_concepts: string[];
      overlap_score: number;
    }> = [];

    let recallQuestions = analysisResult.recall_questions;

    if (analysisResult.decision === 'triggered' && retrievalCandidates.length > 0) {
      const bridge = await generateBridgeQuestion(
        content,
        goal_description,
        retrievalCandidates.map((item) => ({
          title: item.title,
          overlapConcepts: item.overlapConcepts,
        }))
      );

      if (bridge) {
        recallQuestions = applyBridgeQuestion(recallQuestions, bridge);
        retrievalUsed = true;
        relatedItems = retrievalCandidates.map((item) => ({
          content_id: item.contentId,
          title: item.title,
          overlap_concepts: item.overlapConcepts,
          overlap_score: item.overlapScore,
        }));
      }
    }

    const retrievedCount = retrievalUsed ? relatedItems.length : 0;
    const topOverlapScore = retrievalUsed && relatedItems.length > 0 ? relatedItems[0].overlap_score : 0;
    // Count of shared concepts for the top retrieved item (0 when retrieval unused).
    const overlapConceptsCount =
      retrievalUsed && relatedItems.length > 0 ? relatedItems[0].overlap_concepts.length : 0;
    const agentSteps = retrievalUsed ? ['retrieve_related', 'generate_bridge_question'] : [];

    // Step 3: Log to Opik (async, non-blocking) using multi-span trace
    const contentType = getContentType(content_url);
    // Attach .catch() so a late Opik rejection doesn't become unhandled (FUNCTION_INVOCATION_FAILED)
    const opikPromise = logToOpik(
      traceId,
      analysisResult.relevance_score,
      analysisResult.learning_value_score,
      analysisResult.decision,
      analysisResult.concepts.length,
      user_id_hash,
      contentType,
      intervention_policy,
      recallQuestions.length,
      retrievalUsed,
      retrievedCount,
      topOverlapScore,
      overlapConceptsCount,
      agentSteps
    ).catch((error) => {
      console.error('Opik logging failed:', error instanceof Error ? error.message : 'Unknown error');
    });
    await Promise.race([
      opikPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    // Step 4: Return structured results
    const responsePayload: Record<string, unknown> = {
      trace_id: traceId,
      concepts: analysisResult.concepts,
      relevance_score: analysisResult.relevance_score,
      learning_value_score: analysisResult.learning_value_score,
      decision: analysisResult.decision,
      recall_questions: recallQuestions,
      related_items: relatedItems,
      retrieval_used: retrievalUsed,
      retrieved_count: retrievedCount,
    };

    res.status(200).json(responsePayload);
  } catch (error) {
    // Generic error handling
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    console.error('Request processing error:', errorMessage);

    if (res.writableEnded) return;
    if (process.env.NODE_ENV !== 'production') {
      res.status(500).json({
        error: 'Internal server error',
        message: errorMessage,
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
      });
    }
  }
}
