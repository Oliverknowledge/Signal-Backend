/**
 * Hackathon-minimal feedback persistence.
 *
 * TODO: In-memory store does NOT persist across Vercel serverless cold starts.
 * Replace with Vercel KV, Redis, or Prisma when moving beyond demo.
 */

/** Allowed structured reason codes (no free text). */
export const ALLOWED_FEEDBACK_REASONS = [
  'aligned_goal',
  'practical',
  'clear',
  'challenging',
  'not_aligned',
  'too_basic',
  'too_advanced',
  'low_quality',
  'clickbait',
] as const;

export type StoredFeedback = {
  trace_id: string;
  content_id: string;
  feedback: 'useful' | 'not_useful';
  recall_correct?: number;
  recall_total?: number;
  reasons?: string[];
  timestamp: string;
};

const store: StoredFeedback[] = [];

export function persistFeedback(entry: StoredFeedback): void {
  store.push(entry);
}

export function getFeedbackCount(): number {
  return store.length;
}
