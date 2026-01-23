/**
 * OpenAI client for Signal AI analysis
 * Extracts concepts, scores relevance/learning value, and generates recall questions
 */

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface AnalysisResult {
  concepts: string[];
  relevance_score: number;
  learning_value_score: number;
  decision: 'triggered' | 'ignored';
  recall_questions: Array<{
    question: string;
    type: 'mcq' | 'open';
  }>;
}

/**
 * Analyzes content using OpenAI to extract concepts, score relevance/learning value,
 * and generate recall questions if triggered
 */
export async function analyzeContent(
  content: string,
  goalDescription: string,
  knownConcepts: string[],
  weakConcepts: string[]
): Promise<AnalysisResult> {
  const systemPrompt = `You are an AI tutor analyzing educational content for Signal, a learning app. Your job is to:
1. Extract fine-grained learning concepts from the content
2. Score how relevant the content is to the user's learning goal (0-1)
3. Score the learning value of the content (0-1)
4. Decide if the content should trigger learning intervention (both scores >= 0.7)
5. Generate 3-5 recall questions if triggered

Always respond with valid JSON only, no markdown formatting.`;

  const userPrompt = `Analyze the following content against the user's learning goal.

User's Learning Goal: ${goalDescription}

Known Concepts (user already understands): ${knownConcepts.join(', ') || 'None'}
Weak Concepts (user needs practice): ${weakConcepts.join(', ') || 'None'}

Content:
${content}

Respond with a JSON object in this exact format:
{
  "concepts": ["concept1", "concept2", ...],
  "relevance_score": 0.85,
  "learning_value_score": 0.92,
  "decision": "triggered",
  "recall_questions": [
    {"question": "What is X?", "type": "open"},
    {"question": "Which of the following is true about Y? A) Option 1 B) Option 2 C) Option 3", "type": "mcq"}
  ]
}

Extract 5-15 fine-grained concepts. Score relevance (how well content matches the goal) and learning_value (how much the user can learn) on a 0-1 scale. Set decision to "triggered" if both scores >= 0.7, otherwise "ignored". Generate 3-5 recall questions only if triggered.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Using cost-effective model, can upgrade to gpt-4o if needed
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 2000,
    });

    const responseText = completion.choices[0]?.message?.content;
    if (!responseText) {
      throw new Error('No response from OpenAI');
    }

    // Parse JSON response
    const parsed = JSON.parse(responseText);

    // Validate and normalize the response
    const concepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
    const relevance_score = Math.max(0, Math.min(1, Number(parsed.relevance_score) || 0));
    const learning_value_score = Math.max(0, Math.min(1, Number(parsed.learning_value_score) || 0));
    const decision: 'triggered' | 'ignored' = 
      relevance_score >= 0.7 && learning_value_score >= 0.7 ? 'triggered' : 'ignored';
    
    // Ensure decision matches scores
    const finalDecision = parsed.decision === 'triggered' && decision === 'triggered' 
      ? 'triggered' 
      : 'ignored';

    const recall_questions = finalDecision === 'triggered' && Array.isArray(parsed.recall_questions)
      ? parsed.recall_questions
          .filter((q: any) => q && typeof q.question === 'string')
          .map((q: any) => ({
            question: q.question,
            type: (q.type === 'mcq' || q.type === 'open') ? q.type : 'open',
          }))
          .slice(0, 5) // Limit to 5 questions
      : [];

    return {
      concepts: concepts.filter((c: any) => typeof c === 'string').slice(0, 15), // Limit to 15 concepts
      relevance_score,
      learning_value_score,
      decision: finalDecision,
      recall_questions,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`OpenAI analysis failed: ${error.message}`);
    }
    throw new Error('OpenAI analysis failed: Unknown error');
  }
}
