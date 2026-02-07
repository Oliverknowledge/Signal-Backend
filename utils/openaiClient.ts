/**
 * OpenAI client for Signal AI analysis
 * Extracts concepts, scores relevance/learning value, and generates recall questions.
 */

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export type InterventionPolicy = "focused" | "aggressive";
export type LearningMode = "interview_prep" | "assessment_exam_prep" | "general_learning";

const DEFAULT_INTERVENTION_POLICY: InterventionPolicy = "focused";
const DEFAULT_LEARNING_MODE: LearningMode = "general_learning";
const TRIGGER_THRESHOLDS: Record<InterventionPolicy, number> = {
  focused: 0.75,
  aggressive: 0.6,
};

type QuestionPlan = {
  mode: LearningMode;
  modeLabel: string;
  openTarget: number;
  mcqTarget: number;
  difficultyHint: string;
  styleHint: string;
  modeRules: string;
  ordering: "open_first" | "balanced" | "mcq_first";
};

function normalizePolicy(value?: string): InterventionPolicy {
  return value === "aggressive" ? "aggressive" : "focused";
}

function normalizeLearningMode(value?: string): LearningMode {
  if (!value) return DEFAULT_LEARNING_MODE;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

  if (normalized === "interview_prep" || normalized === "interview") return "interview_prep";
  if (
    normalized === "assessment_exam_prep" ||
    normalized === "assessment_prep" ||
    normalized === "assessment" ||
    normalized === "exam_prep" ||
    normalized === "examprep" ||
    normalized === "exam"
  ) return "assessment_exam_prep";
  if (normalized === "general_learning" || normalized === "general" || normalized === "casual") {
    return "general_learning";
  }
  // Legacy mapping.
  if (normalized === "deep_focus" || normalized === "deepfocus") return "interview_prep";
  return "general_learning";
}

function questionPlanForMode(mode: LearningMode): QuestionPlan {
  switch (mode) {
    case "interview_prep":
      return {
        mode,
        modeLabel: "Interview Prep",
        openTarget: 3,
        mcqTarget: 1,
        difficultyHint: "real-world and explanation-heavy",
        styleHint: "spoken reasoning, clarity, and confidence under pressure",
        modeRules: "Prefer prompts that start with 'Explain', 'Walk me through', or 'Why would you choose'.",
        ordering: "open_first",
      };
    case "assessment_exam_prep":
      return {
        mode,
        modeLabel: "Assessment / Exam Prep",
        openTarget: 1,
        mcqTarget: 3,
        difficultyHint: "exam-style and accuracy-focused",
        styleHint: "clear right/wrong phrasing with terminology checks",
        modeRules: "Prefer objective prompts like 'Which of these is true?' and pattern/definition checks.",
        ordering: "mcq_first",
      };
    default:
      return {
        mode: "general_learning",
        modeLabel: "General Learning",
        openTarget: 2,
        mcqTarget: 2,
        difficultyHint: "light-to-moderate",
        styleHint: "balanced and supportive with lower pressure",
        modeRules: "Keep a balanced mix and avoid overly high-pressure framing.",
        ordering: "balanced",
      };
  }
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

export type RelatedItemContext = {
  title: string;
  overlapConcepts: string[];
};

/**
 * Analyzes content using OpenAI to extract concepts, score relevance/learning value,
 * and generate recall questions if triggered.
 */
export async function analyzeContent(
  content: string,
  goalDescription: string,
  knownConcepts: string[],
  weakConcepts: string[],
  interventionPolicy: InterventionPolicy = DEFAULT_INTERVENTION_POLICY,
  learningMode: string = DEFAULT_LEARNING_MODE
): Promise<AnalysisResult> {
  const policy = normalizePolicy(interventionPolicy);
  const mode = normalizeLearningMode(learningMode);
  const questionPlan = questionPlanForMode(mode);
  const triggerThreshold = TRIGGER_THRESHOLDS[policy];
  const totalTargetQuestions = questionPlan.openTarget + questionPlan.mcqTarget;

  const systemPrompt = `You are Signal's analysis engine.
Return ONLY valid JSON matching the provided schema. No markdown, no extra keys.

CRITICAL: Concepts and questions MUST be derived ONLY from the CONTENT. If the content is about Minecraft, output Minecraft concepts; if about cooking, cooking concepts. Never invent topics from the user goal when they are not in the content.

High standards:
- Concepts must be specific and testable (e.g. "redstone repeaters", "biome generation"), from the CONTENT only, not vague ("gaming").
- Avoid duplicates. Prefer 6-10 concepts that actually appear in the content.
- relevance_score and learning_value_score must reflect THIS content only; if content and goal are unrelated, score low (0-1).
- If you output MCQs, they MUST have exactly 4 options and exactly 1 correct answer.
- Honor the requested LEARNING MODE profile for recall question difficulty and style.`;

  const userPrompt = `Analyze the CONTENT below against the user's goal and prior knowledge. Concepts and questions must come ONLY from the CONTENT.

GOAL (short): ${goalDescription}
LEARNING MODE: ${questionPlan.modeLabel}
MODE DIFFICULTY: ${questionPlan.difficultyHint}
MODE STYLE: ${questionPlan.styleHint}
MODE RULES: ${questionPlan.modeRules}

KNOWN (avoid reteaching): ${knownConcepts.join(", ") || "None"}
WEAK (prioritize): ${weakConcepts.join(", ") || "None"}

CONTENT (this is the actual transcript/text; extract concepts and questions from it only):
${content}

Return JSON in this exact schema (no extra fields):
{
  "concepts": ["string"],
  "relevance_score": number,         // 0..1
  "learning_value_score": number,    // 0..1
  "recall_questions": [
    { "type": "open", "question": "string" },
    { "type": "mcq", "question": "string", "options": ["string","string","string","string"], "correct_index": 0 }
  ]
}

Rules:
- concepts: 6-10 items clearly present in the CONTENT.
  - Only include concepts from WEAK if they actually appear in the content; otherwise ignore WEAK for concept list.
- relevance_score: how well THIS content aligns with the GOAL (0..1).
- learning_value_score: how much the user can learn from THIS content given KNOWN/WEAK (0..1).
- recall_questions: ONLY if BOTH scores >= ${triggerThreshold}.
- If triggered, return EXACTLY ${totalTargetQuestions} questions with this mix:
  - open questions: ${questionPlan.openTarget}
  - mcq questions: ${questionPlan.mcqTarget}
- Use ${questionPlan.difficultyHint} difficulty and ${questionPlan.styleHint} wording.
- Do not ask about topics not present in the content.`;

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

    const relevance_score = clamp01(Number(parsed.relevance_score));
    const learning_value_score = clamp01(Number(parsed.learning_value_score));

    // Server is source of truth for the final trigger decision.
    const decision: "triggered" | "ignored" =
      relevance_score >= triggerThreshold && learning_value_score >= triggerThreshold
        ? "triggered"
        : "ignored";

    const rawConcepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
    const concepts = normalizeConcepts(rawConcepts, 10);

    let recall_questions: AnalysisResult["recall_questions"] = [];
    if (decision === "triggered") {
      const rawQuestions = Array.isArray(parsed.recall_questions) ? parsed.recall_questions : [];
      const normalized = normalizeQuestions(rawQuestions).slice(0, 8);
      recall_questions = enforceQuestionPlan(normalized, concepts, questionPlan);
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

/**
 * Generates a single bridge recall question using prior related items.
 * Returns null if the model output is invalid.
 */
export async function generateBridgeQuestion(
  content: string,
  goalDescription: string,
  relatedItems: RelatedItemContext[]
): Promise<{ type: "open"; question: string } | null> {
  if (!relatedItems || relatedItems.length === 0) return null;

  const systemPrompt = `You are Signal's recall question generator.
Return ONLY valid JSON matching the provided schema. No markdown, no extra keys.

CRITICAL: The bridge question must be grounded in the CONTENT and use ONLY the shared concepts provided.
Do not invent topics that are not in the CONTENT.`;

  const relatedBlock = relatedItems
    .slice(0, 2)
    .map((item, idx) => {
      const concepts = item.overlapConcepts.join(", ") || "None";
      return `${idx + 1}. Title: ${item.title}\n   Shared concepts: ${concepts}`;
    })
    .join("\n");

  const userPrompt = `Create ONE open-ended "bridge" recall question that connects the new content
to the user's prior related items. The question should explicitly reference at least one shared concept.

GOAL (short): ${goalDescription}

PRIOR RELATED ITEMS:
${relatedBlock}

CONTENT (new):
${content}

Return JSON in this exact schema (no extra fields):
{
  "type": "open",
  "question": "string"
}

Rules:
- The question must be answerable using the CONTENT.
- It must connect the new content to one or more prior items via shared concepts.
- Keep it concise (8-220 chars).`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 300,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) return null;

    const parsed = JSON.parse(responseText);
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    const type = parsed.type === "open" ? "open" : null;

    if (!type || question.length < 8 || question.length > 220) return null;
    return { type: "open", question };
  } catch {
    return null;
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
    "memory management",
  ]);
  return vague.has(concept.toLowerCase());
}

type OpenQuestion = { type: "open"; question: string };
type MCQQuestion = { type: "mcq"; question: string; options: string[]; correct_index: number };
type NormalizedQuestion = OpenQuestion | MCQQuestion;

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

    const options = Array.isArray(q.options)
      ? q.options
          .filter((o: any) => typeof o === "string")
          .map((o: string) => o.trim())
      : [];
    const correct_index = Number(q.correct_index);

    if (options.length !== 4) continue;
    if (![0, 1, 2, 3].includes(correct_index)) continue;
    if (options.some((o: string) => o.length < 2 || o.length > 120)) continue;

    const optSet = new Set(options.map((o: string) => o.toLowerCase()));
    if (optSet.size !== 4) continue;

    out.push({ type: "mcq", question, options, correct_index });
  }

  return out;
}

function enforceQuestionPlan(
  candidates: NormalizedQuestion[],
  concepts: string[],
  plan: QuestionPlan
): NormalizedQuestion[] {
  const openCandidates = candidates.filter((q): q is OpenQuestion => q.type === "open");
  const mcqCandidates = candidates.filter((q): q is MCQQuestion => q.type === "mcq");

  const openQuestions: OpenQuestion[] = openCandidates.slice(0, plan.openTarget);
  if (openQuestions.length < plan.openTarget) {
    openQuestions.push(
      ...buildFallbackOpenQuestions(concepts, plan.openTarget - openQuestions.length, plan.mode)
    );
  }

  const mcqQuestions: MCQQuestion[] = mcqCandidates.slice(0, plan.mcqTarget);
  if (mcqQuestions.length < plan.mcqTarget) {
    mcqQuestions.push(
      ...buildFallbackMcqQuestions(concepts, plan.mcqTarget - mcqQuestions.length, plan.mode)
    );
  }

  return orderQuestions(openQuestions, mcqQuestions, plan.ordering);
}

function orderQuestions(
  openQuestions: OpenQuestion[],
  mcqQuestions: MCQQuestion[],
  ordering: QuestionPlan["ordering"]
): NormalizedQuestion[] {
  if (ordering === "open_first") {
    return [...openQuestions, ...mcqQuestions];
  }
  if (ordering === "mcq_first") {
    return [...mcqQuestions, ...openQuestions];
  }

  const out: NormalizedQuestion[] = [];
  const maxLen = Math.max(openQuestions.length, mcqQuestions.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < openQuestions.length) out.push(openQuestions[i]);
    if (i < mcqQuestions.length) out.push(mcqQuestions[i]);
  }
  return out;
}

function buildFallbackOpenQuestions(
  concepts: string[],
  needed: number,
  mode: LearningMode
): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (let i = 0; i < needed; i++) {
    const concept = conceptAt(concepts, i);
    let question: string;
    switch (mode) {
      case "assessment_exam_prep":
        question = `Define ${concept} precisely, then apply it to a short test-style example.`;
        break;
      case "interview_prep":
        if (i % 2 == 0) {
          question = `Explain ${concept} in your own words and why it matters in practice.`;
        } else {
          question = `Walk me through when you would choose ${concept} over an alternative.`;
        }
        break;
      default:
        question = `In your own words, what is ${concept} and where would you use it?`;
        break;
    }
    out.push({ type: "open", question });
  }
  return out;
}

function buildFallbackMcqQuestions(
  concepts: string[],
  needed: number,
  mode: LearningMode
): MCQQuestion[] {
  const out: MCQQuestion[] = [];
  for (let i = 0; i < needed; i++) {
    const concept = conceptAt(concepts, i);
    let question: string;
    let correct: string;

    switch (mode) {
      case "assessment_exam_prep":
        question = `Which of these is true about ${concept} in a test scenario?`;
        correct = `A precise definition and correct use of ${concept}`;
        break;
      case "interview_prep":
        question = `Which explanation of ${concept} would sound strongest in an interview?`;
        correct = `The option that is clear, accurate, and grounded in real use`;
        break;
      default:
        question = `Which option best captures the main idea of ${concept}?`;
        correct = `The option that explains ${concept} clearly in context`;
        break;
    }

    const options = [
      correct,
      `A common misconception about ${concept}`,
      `A related but different concept from the same topic`,
      `An unrelated claim that does not explain ${concept}`,
    ];

    out.push({
      type: "mcq",
      question,
      options,
      correct_index: 0,
    });
  }
  return out;
}

function conceptAt(concepts: string[], index: number): string {
  if (!concepts.length) return "the main concept from this content";
  return concepts[index % concepts.length];
}
