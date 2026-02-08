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
): Promise<{ score: number; reasoning: string; key_points: string[]; could_have_said: string[] }> {
  const prompt = `You are grading a learner's open-ended recall answer.
The learner watched/read content titled "${contentTitle}" and was asked this question: "${question}"

Their answer: "${userAnswer}"

Rate how correct and complete their answer is on a scale of 0.0 to 1.0, where:
- 0.0 = completely wrong or irrelevant
- 0.5 = partially correct, shows some understanding
- 0.7 = mostly correct, demonstrates good understanding
- 1.0 = fully correct and comprehensive

Return a short, stable explanation of the grade, 2-3 key points that matter for this question, and 2-3 concrete things the learner could have added.
Respond with ONLY valid JSON in exactly this shape (no markdown, no extra text):
{
  "score": 0.85,
  "reasoning": "One concise sentence explaining why.",
  "key_points": ["point A", "point B"],
  "could_have_said": ["specific missing idea 1", "specific missing idea 2"]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You grade recall answers. Return only valid JSON with "score" (0-1), "reasoning" (string), "key_points" (array of 2-3 short strings), and "could_have_said" (array of 2-3 specific missing ideas). Reasoning must be one concise sentence referencing the key concept.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.0, // tighter determinism
    max_tokens: 220,
  });

  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error('No response from grader');

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Defensive logging for debugging
    console.error('[GradeRecall] JSON parse failed:', e, 'raw:', text);
    throw new Error('Invalid JSON from grader');
  }

  const score = Math.max(0, Math.min(1, Number(parsed.score) ?? 0));
  const reasoning =
    typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

  const keyPointsRaw = Array.isArray(parsed.key_points) ? parsed.key_points : [];
  const key_points = keyPointsRaw
    .filter((x: unknown) => typeof x === 'string')
    .slice(0, 3);

  const couldHaveSaidRaw = Array.isArray(parsed.could_have_said) ? parsed.could_have_said : [];
  const could_have_said = couldHaveSaidRaw
    .filter((x: unknown) => typeof x === 'string')
    .slice(0, 3);

  return { score, reasoning, key_points, could_have_said };
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
    const { score, reasoning, key_points, could_have_said } = await gradeAnswer(
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
      reasoning,
      key_points,
      could_have_said
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Grading failed';
    console.error('[GradeRecall] Error:', msg);
    res.status(500).json({
      error: 'Grading failed',
      message: process.env.NODE_ENV !== 'production' ? msg : undefined,
    });
  }
}
