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
import { analyzeContent } from '../utils/openaiClient.js';
import { logToOpik } from '../utils/opikLogger.js';

// Request schema validation
const AnalyzeRequestSchema = z.object({
  content_url: z.string().url(),
  user_id_hash: z.string().min(1),
  goal_id: z.string().min(1),
  goal_description: z.string().min(1),
  intervention_policy: z.enum(['focused', 'aggressive']).default('focused'),
  known_concepts: z.array(z.string()).default([]),
  weak_concepts: z.array(z.string()).default([]),
});

type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

/**
 * Determines content type from URL
 */
function getContentType(url: string): 'video' | 'article' {
  const youtubePattern = /(?:youtube\.com|youtu\.be)/;
  return youtubePattern.test(url) ? 'video' : 'article';
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
      known_concepts,
      weak_concepts,
    } = validationResult.data;

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
        analyzeContent(content, goal_description, known_concepts, weak_concepts, intervention_policy),
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
      analysisResult.recall_questions.length
    ).catch((error) => {
      console.error('Opik logging failed:', error instanceof Error ? error.message : 'Unknown error');
    });
    await Promise.race([
      opikPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);

    // Step 4: Return structured results
    res.status(200).json({
      trace_id: traceId,
      concepts: analysisResult.concepts,
      relevance_score: analysisResult.relevance_score,
      learning_value_score: analysisResult.learning_value_score,
      decision: analysisResult.decision,
      recall_questions: analysisResult.recall_questions,
    });
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
