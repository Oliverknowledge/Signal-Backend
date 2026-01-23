/**
 * OpenAI client for Signal AI analysis
 * Extracts concepts, scores relevance/learning value, and generates recall questions
 */

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface AnalysisResult {
  concepts: string[];
  relevance_score: number;
  learning_value_score: number;
  decision: "triggered" | "ignored";
  recall_questions: Array<
    | { type: "open"; question: string }
    | { type: "mcq"; question: string; options: string[]; correct_index: number }
  >;
}

/**
 * Analyzes content using OpenAI to extract concepts, score relevance/learning value,
 * and generate recall questions if triggered.
 */
export async function analyzeContent(
  content: string,
  goalDescription: string,
  knownConcepts: string[],
  weakConcepts: string[]
): Promise<AnalysisResult> {
  const systemPrompt = `You are Signal’s analysis engine.
Return ONLY valid JSON matching the provided schema. No markdown, no extra keys.

High standards:
- Concepts must be specific and testable (e.g., "RAII", "std::unique_ptr ownership semantics"), not vague ("programming").
- Prefer interview-relevant phrasing: include pitfalls, edge cases, and correctness when applicable.
- Avoid duplicates and near-duplicates. Prefer 6–10 best concepts over long lists.
- Scores must be calibrated (0–1). Don’t always output >0.8.
- If you output MCQs, they MUST have exactly 4 options and exactly 1 correct answer.`;

  const userPrompt = `Analyze the content against the user's goal and prior knowledge.

GOAL (short): ${goalDescription}

KNOWN (avoid reteaching): ${knownConcepts.join(", ") || "None"}
WEAK (prioritize): ${weakConcepts.join(", ") || "None"}

CONTENT (may be long; focus on the core teachable parts):
${content}

Return JSON in this exact schema (no extra fields):
{
  "concepts": ["string"],
  "relevance_score": number,        // 0..1
  "learning_value_score": number,    // 0..1
  "recall_questions": [
    { "type": "open", "question": "string" },
    { "type": "mcq", "question": "string", "options": ["string","string","string","string"], "correct_index": 0 }
  ]
}

Rules:
- concepts: 6–10 items, unique, specific, noun-phrases.
  - Include at least 2 from WEAK if present.
  - Include at least 2 "pitfall/edge-case" concepts if applicable.
- relevance_score: alignment of THIS content to GOAL (0..1).
- learning_value_score: how much the user can learn given KNOWN/WEAK (0..1).
- recall_questions:
  - ONLY include questions if BOTH scores >= 0.7. Otherwise return [].
  - If triggered, return EXACTLY 4 questions: 2 open + 2 mcq.
  - Questions must test concepts found in the content.
  - MCQs: 4 plausible options, one correct_index (0..3). No "All of the above". No trick answers.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1800,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) throw new Error("No response from OpenAI");

    const parsed = JSON.parse(responseText);

    // Normalize scores
    const relevance_score = clamp01(Number(parsed.relevance_score));
    const learning_value_score = clamp01(Number(parsed.learning_value_score));

    // Server is source of truth for decision
    const decision: "triggered" | "ignored" =
      relevance_score >= 0.7 && learning_value_score >= 0.7
        ? "triggered"
        : "ignored";

    // Concepts: sanitize + dedupe + cap + remove too-vague
    const rawConcepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
    const concepts = normalizeConcepts(rawConcepts, 10);

    // Questions: only if triggered, then normalize + enforce minimum count via fallback
    let recall_questions: AnalysisResult["recall_questions"] =
      decision === "triggered" && Array.isArray(parsed.recall_questions)
        ? normalizeQuestions(parsed.recall_questions).slice(0, 5)
        : [];

    // Ensure at least 3 questions (demo-safe) and ideally 4, without trusting model
    if (decision === "triggered") {
      const target = 4;
      if (recall_questions.length < target) {
        const needed = target - recall_questions.length;
        const extras = buildFallbackQuestions(concepts, needed);
        recall_questions = recall_questions.concat(extras).slice(0, target);
      } else if (recall_questions.length > target) {
        recall_questions = recall_questions.slice(0, target);
      }
    } else {
      recall_questions = [];
    }

    return {
      concepts,
      relevance_score,
      learning_value_score,
      decision,
      recall_questions,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`OpenAI analysis failed: ${msg}`);
  }
}

/** Helpers */

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function normalizeConcepts(input: any[], max: number): string[] {
  const cleaned = input
    .filter((c) => typeof c === "string")
    .map((c) => c.trim())
    .filter((c) => c.length >= 3 && c.length <= 80)
    .filter((c) => !isTooVague(c));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cleaned) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function isTooVague(concept: string): boolean {
  const vague = new Set([
    "programming",
    "coding",
    "software",
    "computer science",
    "development",
    "learning",
    "technology",
    "basics",
    "memory management", // too broad on its own; allow more specific variants
  ]);
  return vague.has(concept.toLowerCase());
}

type NormalizedQuestion =
  | { type: "open"; question: string }
  | { type: "mcq"; question: string; options: string[]; correct_index: number };

function normalizeQuestions(input: any[]): NormalizedQuestion[] {
  const out: NormalizedQuestion[] = [];

  for (const q of input) {
    if (!q || typeof q !== "object") continue;

    const type = q.type === "mcq" ? "mcq" : q.type === "open" ? "open" : null;
    const question = typeof q.question === "string" ? q.question.trim() : "";

    if (!type || question.length < 8 || question.length > 220) continue;

    if (type === "open") {
      out.push({ type: "open", question });
      continue;
    }

    // MCQ validation
    const options = Array.isArray(q.options)
      ? q.options
          .filter((o: any) => typeof o === "string")
          .map((o: string) => o.trim())
      : [];

    const correct_index = Number(q.correct_index);

    if (options.length !== 4) continue;
    if (![0, 1, 2, 3].includes(correct_index)) continue;

    const optSet = new Set(options.map((o: any) => o.toLowerCase()));
    if (optSet.size !== 4) continue;

    // Avoid garbage options
    if (options.some((o: any) => o.length < 2 || o.length > 120)) continue;

    out.push({ type: "mcq", question, options, correct_index });
  }

  return out;
}

function buildFallbackQuestions(
  concepts: string[],
  needed: number
): Array<{ type: "open"; question: string }> {
  const picked = concepts.slice(0, Math.max(needed, 1));
  const extras: Array<{ type: "open"; question: string }> = [];

  for (let i = 0; i < needed; i++) {
    const c = picked[i] ?? "this concept";
    extras.push({
      type: "open",
      question: `Explain ${c} in 1–2 sentences and name one common mistake or pitfall.`,
    });
  }

  return extras;
}
