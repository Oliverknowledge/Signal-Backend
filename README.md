# Signal Opik Relay Service

A TypeScript serverless relay service that forwards anonymized observability events from Signal iOS app to Opik. Deploys on Vercel serverless functions.

## Features

- ✅ **POST /api/opik-log**: Single endpoint for trace logging
- ✅ **JSON Validation**: Strict Zod schema validation
- ✅ **Opik Integration**: REST API integration with environment-based configuration
- ✅ **Privacy-first**: Rejects any payloads containing user data
- ✅ **Security**: Shared secret token authentication
- ✅ **Serverless**: Vercel serverless functions (Node.js runtime)
- ✅ **Non-blocking**: Async Opik calls don't block API responses

## Architecture

This TypeScript serverless relay:
- Accepts only system-level metrics (scores, counts, decisions)
- Validates requests against a strict Zod schema
- Rejects any payloads with forbidden user data fields
- Forwards validated metrics to Opik via REST API
- Never stores or logs user data
- Runs entirely server-side (TypeScript/Node.js)

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
   RELAY_TOKEN=your-secret-relay-token-here
   OPIK_API_KEY=your-opik-api-key
   OPIK_URL=https://api.opik.ai/v1 (optional, defaults to this)
   OPIK_PROJECT_NAME=signal (optional)
   OPIK_WORKSPACE=your-workspace (optional)
   ```

4. **Redeploy after setting environment variables:**
   ```bash
   vercel --prod
   ```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RELAY_TOKEN` | Yes | Shared secret token for API authentication |
| `OPIK_API_KEY` | Yes | Opik API key for trace submission |
| `OPIK_URL` | No | Opik API base URL (defaults to `https://api.opik.ai/v1`) |
| `OPIK_PROJECT_NAME` | No | Opik project name for traces |
| `OPIK_WORKSPACE` | No | Opik workspace identifier |

## API Endpoint

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
