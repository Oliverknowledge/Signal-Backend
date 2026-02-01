# Opik feedback: docs vs our implementation

## What Opik’s docs say

From [Log user feedback](https://www.comet.com/docs/opik/tracing/annotate_traces):

1. **Intended flow**  
   You log feedback **on an existing trace** using the SDK:
   - Create a trace (e.g. when you run content evaluation).
   - Later call **`client.logTracesFeedbackScores([{ id: trace.id, name: "…", value: 0.9, reason: "…" }])`** (docs example).
   - In the SDK, that maps to **`client.traces.addTraceFeedbackScore(traceId, { body: { name, value, source, reason? } })`**, where `traceId` is the **Opik-assigned trace id** (the `id` of the trace you created).

2. **What “feedback” is in Opik**  
   - **Feedback scores**: name (e.g. `"overall_quality"`), numeric value, optional reason, source (`"ui"` | `"sdk"` | `"online_scoring"`).
   - They are attached to **one trace** (or span) by its **Opik id**.
   - The UI shows them in “Feedback scores” on that trace, and uses them for averages, annotation, online evaluation, etc.

3. **Other mechanisms**  
   - You can also annotate traces in the Opik UI, use online evaluation (LLM-as-judge), and define custom feedback types in **Feedback definitions**.

So in Opik’s model, “feedback is given to the agent” = a **feedback score** is added to the **same trace** that represents that agent run (same Opik trace id).

---

## What we do today

- **Content evaluation** (e.g. `analyze.ts` + `opikLogger`, or `opik-log`): we create **one Opik trace** and put our **`trace_id`** (UUID) in metadata as `signal.trace_id`. We do **not** persist the **Opik trace id** anywhere.
- **Feedback** (`POST /api/feedback`): the client sends **our** `trace_id` (UUID). We:
  - Persist feedback in our in-memory store.
  - Create a **new Opik trace** with a `user_feedback` span and the same `signal.trace_id` in metadata.

So in Opik you get:

- **Trace A**: content evaluation, metadata `signal.trace_id = <uuid>`.
- **Trace B**: feedback, metadata `signal.trace_id = <uuid>`.

They are **correlated by** `signal.trace_id`, but the feedback is **not** attached as a **feedback score** on Trace A. It’s a separate trace. Opik’s “Feedback scores” and annotation features for that content run would not see our feedback unless we start using the native feedback API.

---

## How you can “see” feedback today

1. **Our API**  
   - Success response: `200 { ok: true }` means we accepted the feedback and sent it to Opik (and stored it in-memory).

2. **In Opik**  
   - Open the **Traces** view and filter or search by metadata **`signal.trace_id`** = the UUID you sent.
   - You should see **two** traces for the same UUID: the content-evaluation trace and the feedback trace (with the `user_feedback` span).
   - So “feedback given to the agent” in our current implementation = “a second trace with the same `signal.trace_id` and a `user_feedback` span”.

3. **Native “Feedback scores” on the original trace**  
   - Not used yet. To do that we’d need to call **`addTraceFeedbackScore(opikTraceId, { body: { name, value, source, reason } })`** for the **same** Opik trace we created at content-evaluation time, which requires either:
     - Storing a mapping **our `trace_id` → Opik trace id** when we create the content trace, or  
     - Resolving the Opik trace id from metadata (e.g. by a “find trace by metadata” API) and then adding the score.

---

## Summary

- I didn’t read every page of Opik’s docs; this is based on the “Log user feedback” / annotate traces page, Feedback definitions, and the SDK types.
- **Opik’s model**: feedback = **feedback scores** on an **existing** trace (by Opik trace id).
- **Our model**: feedback = a **new** trace with a `user_feedback` span and the same `signal.trace_id` in metadata, so you see it in Opik by correlating on that UUID.
- To align with Opik’s native feedback (scores on the same trace, UI “Feedback scores”, etc.), we’d need to store or resolve the Opik trace id and call `addTraceFeedbackScore` (or the batch equivalent) instead of (or in addition to) creating the feedback trace.
