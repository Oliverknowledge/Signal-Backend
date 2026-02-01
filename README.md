# Signal Backend Service

A TypeScript serverless backend for Signal iOS app. Provides AI-powered content analysis and observability logging. Deploys on Vercel serverless functions.

## Features

- ✅ **POST /api/analyze**: Core AI decision endpoint for content analysis
- ✅ **POST /api/opik-log**: Observability trace logging endpoint
- ✅ **Real AI Analysis**: OpenAI-powered concept extraction and scoring
- ✅ **Content Fetching**: YouTube transcript and HTML content extraction
- ✅ **JSON Validation**: Strict Zod schema validation
- ✅ **Opik Integration**: REST API integration with environment-based configuration
- ✅ **Privacy-first**: Never leaks user data to Opik
- ✅ **Serverless**: Vercel serverless functions (Node.js runtime)
- ✅ **Non-blocking**: Async Opik calls don't block API responses

## Architecture

This TypeScript serverless backend provides two main endpoints:

### `/api/analyze` - AI Decision Endpoint
The core AI brain of Signal that:
- Fetches content from URLs (YouTube transcripts or HTML articles)
- Uses OpenAI to extract learning concepts and score content
- Generates recall questions for triggered content
- Logs decisions to Opik (without user data)
- Returns structured analysis results to the iOS app

### `/api/opik-log` - Observability Relay
A relay service that:
- Accepts only system-level metrics (scores, counts, decisions)
- Validates requests against a strict Zod schema
- Rejects any payloads with forbidden user data fields
- Forwards validated metrics to Opik via REST API
- Never stores or logs user data

Both endpoints run entirely server-side (TypeScript/Node.js) and never persist user data.

## Deployment to Vercel

### Prerequisites

- Node.js 18+ installed
- Vercel CLI installed (`npm i -g vercel`)
- Opik account with API key

### Steps

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Deploy to Vercel:**
   ```bash
   vercel
   ```

3. **Set environment variables in Vercel dashboard:**
   - Go to your project settings → Environment Variables
   - Add the following:

   ```
   OPENAI_API_KEY=your-openai-api-key
   RAPIDAPI_KEY=your-rapidapi-key
   RELAY_TOKEN=your-secret-relay-token-here
   OPIK_API_KEY=your-opik-api-key
   OPIK_URL_OVERRIDE=https://www.comet.com/opik/api (recommended for Opik Cloud)
   OPIK_PROJECT_NAME=signal (optional)
   OPIK_WORKSPACE_NAME=your-workspace (or use OPIK_WORKSPACE)
   ```

4. **Redeploy after setting environment variables:**
   ```bash
   vercel --prod
   ```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for content analysis |
| `RAPIDAPI_KEY` | Yes | RapidAPI key for YouTube transcript fetching |
| `RELAY_TOKEN` | Yes | Shared secret token for `/api/opik-log` and `/api/feedback` authentication |
| `OPIK_API_KEY` | Yes | Opik API key for trace submission |
| `OPIK_URL_OVERRIDE` | No | Opik API base URL override (Opik Cloud: `https://www.comet.com/opik/api`) |
| `OPIK_URL` | No | Alternative name for Opik API base URL |
| `OPIK_PROJECT_NAME` | No | Opik project name for traces |
| `OPIK_WORKSPACE_NAME` | No | Opik workspace name |
| `OPIK_WORKSPACE` | No | Alternative name for Opik workspace name |

## API Endpoints

### `POST /api/analyze`

Core AI decision endpoint that analyzes content and generates learning interventions.

#### Request Body Schema

```json
{
  "content_url": "https://youtube.com/watch?v=...",
  "user_id_hash": "abc123...",
  "goal_id": "goal-123",
  "goal_description": "Learn machine learning fundamentals",
  "known_concepts": ["neural networks", "backpropagation"],
  "weak_concepts": ["gradient descent", "optimization"]
}
```

#### Response

**Success (200):**
```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "concepts": ["gradient descent", "learning rate", "optimization", ...],
  "relevance_score": 0.85,
  "learning_value_score": 0.92,
  "decision": "triggered",
  "recall_questions": [
    {
      "question": "What is gradient descent?",
      "type": "open"
    },
    {
      "question": "Which learning rate is optimal? A) 0.1 B) 1.0 C) 10.0",
      "type": "mcq"
    }
  ]
}
```

**Error (400/500):**
```json
{
  "error": "Error message",
  "message": "Detailed error message (dev only)"
}
```

#### Example cURL Request

```bash
curl -X POST https://your-project.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "content_url": "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "user_id_hash": "abc123",
    "goal_id": "goal-123",
    "goal_description": "Learn machine learning",
    "known_concepts": ["neural networks"],
    "weak_concepts": ["gradient descent"]
  }'
```

### `POST /api/opik-log`

Forwards anonymized observability events to Opik.

#### Headers

```
X-Signal-Relay-Token: <your-relay-token>
Content-Type: application/json
```

#### Request Body Schema

```json
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "content_evaluation" | "user_feedback",
  "content_type": "video" | "article",
  "concept_count": 5,
  "relevance_score": 0.85,
  "learning_value_score": 0.92,
  "decision": "triggered" | "ignored",
  "user_feedback": "useful" | "not_useful" | null,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### Response

**Success (200):**
```json
{
  "ok": true
}
```

**Error (400/401/500):**
```json
{
  "error": "Error message"
}
```

## Example cURL Request

```bash
curl -X POST https://your-project.vercel.app/api/opik-log \
  -H "Content-Type: application/json" \
  -H "X-Signal-Relay-Token: your-secret-relay-token-here" \
  -d '{
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "event_type": "content_evaluation",
    "content_type": "video",
    "concept_count": 5,
    "relevance_score": 0.85,
    "learning_value_score": 0.92,
    "decision": "triggered",
    "user_feedback": null,
    "timestamp": "2024-01-15T10:30:00Z"
  }'
```

## Client Integration

This is a **server-side TypeScript relay**. Clients (iOS, web, etc.) should send HTTP POST requests to the deployed endpoint.

### Example Client Request (any language)

```bash
POST https://your-project.vercel.app/api/opik-log
Headers:
  Content-Type: application/json
  X-Signal-Relay-Token: your-secret-relay-token-here

Body:
{
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "content_evaluation",
  "content_type": "video",
  "concept_count": 5,
  "relevance_score": 0.85,
  "learning_value_score": 0.92,
  "decision": "triggered",
  "user_feedback": null,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

The relay validates the request and forwards it to Opik. No client-side SDK required.

## Privacy Constraints

The API automatically rejects requests containing any of these forbidden fields:

- `raw_content`, `content`
- `transcript`, `transcripts`
- `user_goals`, `goals`
- `emotional_feedback`, `emotion`
- `user_id`, `email`, `name`, `username`
- `device_id`, `ip_address`

Only numeric, boolean, and string metrics are accepted. No user data is ever logged or stored.

## Data Flow

### `/api/analyze` Endpoint Flow

```
1. iOS App → POST /api/analyze
   ├─ Input: content_url, user_id_hash, goal_description, known_concepts, weak_concepts
   │
2. Content Fetching
   ├─ YouTube URL → Extract video ID → Fetch transcript
   ├─ Other URL → Fetch HTML → Extract readable text
   └─ Limit to ~50k characters (safe token limit)
   │
3. OpenAI Analysis
   ├─ Extract fine-grained learning concepts (5-15 concepts)
   ├─ Score relevance_score (0-1) against user goal
   ├─ Score learning_value_score (0-1) for educational value
   ├─ Decision: triggered if both scores >= 0.7, else ignored
   └─ Generate 3-5 recall questions if triggered
   │
4. Opik Logging (async, non-blocking)
   ├─ Send: trace_id, relevance_score, learning_value_score, decision, concept_count
   ├─ Send: user_id_hash (as attribute only, never raw user data)
   └─ Never send: content, transcript, goal_description, questions
   │
5. Response to iOS App
   └─ Return: trace_id, concepts, scores, decision, recall_questions
```

### Privacy Guarantees

- **Never sent to Opik**: Raw content, transcripts, goal descriptions, recall questions
- **Only sent to Opik**: Scores, decision, concept count, user_id_hash (hashed identifier)
- **Used only for AI reasoning**: `goal_description` is used in OpenAI prompt but never logged
- **No persistence**: All data is processed in-memory, nothing is stored server-side

### Processing Steps

1. **Content Fetching** (30s timeout)
   - YouTube: Extracts video ID and fetches transcript via YouTube API
   - Articles: Fetches HTML and extracts text using Cheerio
   - Limits content to safe token length (~50k chars)

2. **LLM Analysis** (60s timeout)
   - Uses OpenAI GPT-4o-mini for cost-effective analysis
   - Extracts concepts, scores relevance/learning value
   - Decides triggered (both scores ≥ 0.7) vs ignored
   - Generates recall questions only if triggered

3. **Opik Logging** (5s timeout, async)
   - Creates trace with UUID
   - Sends only anonymized metrics
   - Never blocks API response

## Troubleshooting

### `FUNCTION_INVOCATION_FAILED` (Vercel)

This usually means the serverless function crashed (uncaught exception or timeout).

1. **Check which route fails**  
   Call `/api/analyze`, `/api/feedback`, and `/api/opik-log` separately to see which returns this error.

2. **Environment variables**  
   In Vercel → Project → Settings → Environment Variables, ensure:
   - `OPENAI_API_KEY` – required for `/api/analyze`
   - `RAPIDAPI_KEY` – required for YouTube transcripts in `/api/analyze`
   - `RELAY_TOKEN` – required for `/api/opik-log` and `/api/feedback`
   - `OPIK_API_KEY` – optional for Opik logging; if missing, logging is skipped (no crash)

3. **Logs**  
   In Vercel → Project → Deployments → select a deployment → Functions → click the failing function and check **Logs** for the real error (e.g. missing env, timeout, OpenAI/RapidAPI error).

4. **Timeouts**  
   `api/analyze` has `maxDuration: 60`; content fetch has 30s and OpenAI has 60s. Very long content or slow APIs can cause timeouts.

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Build
npm run build
```

## License

MIT
