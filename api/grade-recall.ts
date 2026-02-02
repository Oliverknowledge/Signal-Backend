/**
 * POST /api/grade-recall
 * Grades open-ended recall answers using an LLM.
 * Returns a correctness score (0-1) and logs to Opik.
 */

import { z } from 'zod';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateRelayToken } from '../utils/relayAuth.js';
import { validatePrivacyConstraintsRecursive } from '../utils/privacy.js';
import OpenAI from 'openai';
import { Opik } from 'opik';

const GradeRecallSchema = z.object({
  trace_id: z.string().uuid(),
  content_id: z.string().min(1),
  content_title: z.string().min(1).max(500),
  question: z.string().min(5).max(1000),
  user_answer: z.string().min(5).max(2000),
  timestamp: z.string().datetime(),
});

type GradeRecallRequest = z.infer<typeof GradeRecallSchema>;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CORRECTNESS_THRESHOLD = 0.6;

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
      console.error('[Opik] Grade-recall init failed:', e);
      return null;
    }
  })();
  return opikClientPromise;
}

async function gradeAnswer(
  question: string,
  userAnswer: string,
  contentTitle: string
): Promise<{ score: number; reasoning: string }> {
  const prompt = `You are grading a learner's open-ended recall answer. The learner watched/read content titled "${contentTitle}" and was asked this question: "${question}"

Their answer: "${userAnswer}"

Rate how correct and complete their answer is on a scale of 0.0 to 1.0, where:
- 0.0 = completely wrong or irrelevant
- 0.5 = partially correct, shows some understanding
- 0.7 = mostly correct, demonstrates good understanding
- 1.0 = fully correct and comprehensive

Consider: Does the answer demonstrate understanding of the key concept? Is it accurate? Is it reasonably complete given the question?

Respond with ONLY valid JSON in this exact format (no markdown, no extra text):
{"score": 0.85, "reasoning": "Brief explanation in one sentence"}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You grade recall answers. Return only valid JSON with "score" (0-1) and "reasoning" (string).',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 200,
  });

  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error('No response from grader');

  const parsed = JSON.parse(text);
  const score = Math.max(
    0,
    Math.min(1, Number(parsed.score) ?? 0)
  );
  const reasoning =
    typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

  return { score, reasoning };
}

async function logGradeToOpik(
  data: GradeRecallRequest,
  score: number,
  correct: boolean
): Promise<void> {
  const client = await getOpikClient();
  if (!client) return;

  try {
    const trace = client.trace({
      id: data.trace_id,
      name: 'signal_content_analysis',
      startTime: new Date(data.timestamp),
      input: {
        'event.type': 'open_ended_recall_graded',
        'content.id': data.content_id,
        'recall.open_ended.score': score,
        'recall.open_ended.correct': correct,
      },
      output: {},
      metadata: {
        'signal.trace_id': data.trace_id,
        'event.type': 'open_ended_recall_graded',
        'content.id': data.content_id,
        'recall.open_ended.score': score,
        'recall.open_ended.correct': correct,
      },
    });

    const span = trace.span({
      name: 'open_ended_recall_graded',
      type: 'general',
      startTime: new Date(data.timestamp),
      input: {
        'event.type': 'open_ended_recall_graded',
        'content.id': data.content_id,
        'recall.open_ended.score': score,
        'recall.open_ended.correct': correct,
      },
      output: {},
      metadata: {
        'event.type': 'open_ended_recall_graded',
        'content.id': data.content_id,
        'recall.open_ended.score': score,
        'recall.open_ended.correct': correct,
      },
    });
    span.end();
    trace.end();
    await client.flush();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Opik] Grade-recall span log failed:', msg);
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
    res
      .status(401)
      .json({ error: 'Unauthorized: Invalid or missing relay token' });
    return;
  }

  const privacyCheck = validatePrivacyConstraintsRecursive(req.body);
  if (!privacyCheck.valid) {
    res.status(400).json({ error: privacyCheck.error });
    return;
  }

  const parseResult = GradeRecallSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'Invalid request schema',
      details: parseResult.error.errors,
    });
    return;
  }

  const data = parseResult.data;

  try {
    const { score } = await gradeAnswer(
      data.question,
      data.user_answer,
      data.content_title
    );
    const correct = score >= CORRECTNESS_THRESHOLD;

    void logGradeToOpik(data, score, correct);

    res.status(200).json({
      score: Math.round(score * 100) / 100,
      correct,
      threshold: CORRECTNESS_THRESHOLD,
    });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : 'Grading failed';
    console.error('[GradeRecall] Error:', msg);
    res.status(500).json({
      error: 'Grading failed',
      message: process.env.NODE_ENV !== 'production' ? msg : undefined,
    });
  }
}
