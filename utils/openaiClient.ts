/**
 * OpenAI client for Signal AI analysis
 * Extracts concepts, scores relevance/learning value, and generates recall questions
 */

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type InterventionPolicy = "focused" | "aggressive";

const DEFAULT_INTERVENTION_POLICY: InterventionPolicy = "focused";
const TRIGGER_THRESHOLDS: Record<InterventionPolicy, number> = {
  focused: 0.75,
  aggressive: 0.6,
};

function normalizePolicy(value?: string): InterventionPolicy {
  return value === "aggressive" ? "aggressive" : "focused";
}

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
  weakConcepts: string[],
  interventionPolicy: InterventionPolicy = DEFAULT_INTERVENTION_POLICY
): Promise<AnalysisResult> {
  const policy = normalizePolicy(interventionPolicy);
  const triggerThreshold = TRIGGER_THRESHOLDS[policy];

  const systemPrompt = `You are Signal’s analysis engine.
Return ONLY valid JSON matching the provided schema. No markdown, no extra keys.

CRITICAL: Concepts and questions MUST be derived ONLY from the CONTENT. If the content is about Minecraft, output Minecraft concepts; if about cooking, cooking concepts. Never invent topics from the user goal when they are not in the content.

High standards:
- Concepts must be specific and testable (e.g. "redstone repeaters", "biome generation")—must come from the CONTENT only, not vague ("gaming").
- Avoid duplicates. Prefer 6–10 concepts that actually appear in the content.
- relevance_score and learning_value_score must reflect THIS content only; if content and goal are unrelated, score low (0–1).
- If you output MCQs, they MUST have exactly 4 options and exactly 1 correct answer.`;

  const userPrompt = `Analyze the CONTENT below against the user's goal and prior knowledge. Concepts and questions must come ONLY from the CONTENT—do not use the goal to invent topics that aren't in the content.

GOAL (short): ${goalDescription}

KNOWN (avoid reteaching): ${knownConcepts.join(", ") || "None"}
WEAK (prioritize): ${weakConcepts.join(", ") || "None"}

CONTENT (this is the actual transcript/text—extract concepts and questions from it only):
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
- concepts: 6–10 items that actually appear or are clearly discussed in the CONTENT. Same topic as the content (e.g. if content is about Minecraft, concepts must be Minecraft-related).
  - Only include concepts from WEAK if they actually appear in the content; otherwise ignore WEAK for concept list.
- relevance_score: how well THIS content aligns with the GOAL (0..1). If content and goal are unrelated (e.g. Minecraft content vs "Learn C++"), score low.
- learning_value_score: how much the user can learn from THIS content given KNOWN/WEAK (0..1).
- recall_questions: ONLY if BOTH scores >= ${triggerThreshold}. If triggered, EXACTLY 4 questions (2 open, 2 mcq) that test concepts FROM THE CONTENT. Do not ask about topics not in the content. MCQs: 4 options, one correct_index (0..3).`;

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

    // Server is source of truth for decision (policy-adjusted thresholds).
    const decision: "triggered" | "ignored" =
      relevance_score >= triggerThreshold && learning_value_score >= triggerThreshold
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
