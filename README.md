# Embeddable AI Agent

> **Status**: Working prototype with active development. Multiple implementation versions preserved for comparison and architectural learning.

A production-ready embeddable AI agent that transforms any website into an interactive, AI-assisted experience. Add a single script tag and give your users an intelligent assistant that understands your site's content and can take actions on their behalf.

## Core Capabilities

**Autonomous Browser Interaction**
- Real-time DOM analysis and element indexing
- Semantic understanding of page structure and content
- Multi-step action planning and execution
- Intelligent retry logic with stability detection

**Universal Compatibility**
- Works on any website via script injection
- Shadow DOM traversal for modern web components
- Cross-origin compatible architecture
- Zero dependencies on the target site

**Production Features**
- Conversation persistence and history management
- Per-site rate limiting with sliding window
- Multi-tenant architecture with site isolation
- Real-time action feed and monitoring dashboard

## Technical Architecture

### DOM Distillation Engine

The agent uses a novel DOM distillation approach that converts complex HTML structures into a compact, LLM-friendly format:

```typescript
// Example distilled output
Navigation: [1] Home [2] Products [3] Contact
Main Content:
  Heading: "Welcome to Dashboard"
  [4] Get Started button
  Form:
    [5] Email input (email@example.com)
    [6] Password input (••••••••)
    [7] Submit button
```

Key innovations:
- **Indexed elements**: Every interactive element gets a stable numeric ID
- **Semantic grouping**: Navigation, main content, forms, modals automatically detected
- **Context preservation**: Labels, placeholders, and surrounding text captured
- **Efficiency**: 10KB+ DOM compressed to <2KB for LLM context

### Action Execution System

The agent speaks a structured action language:

```typescript
CLICK [element_id]           // Click any element
TYPE [element_id] "text"     // Fill inputs
SCROLL up|down               // Navigate page
WAIT                         // Wait for stability
ANSWER "response"            // Respond to user
```

**Stability Detection**:
- MutationObserver tracks DOM changes
- PerformanceObserver monitors network activity
- Configurable debounce windows (300ms default)
- Automatic re-observation after actions

### LLM Integration

Currently powered by Google Gemini 2.5 Flash with optimized parameters:

```typescript
{
  temperature: 0.15,          // Deterministic actions
  maxOutputTokens: 800,       // Concise responses
  systemInstruction: { ... }  // Structured action grammar
}
```

**History Compression**: Automatic summarization when conversations exceed context limits, preserving key state while reducing token usage.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Target Website (any site)                                  │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ <script src="embed?siteId=xxx"></script>               │ │
│  │ ↓ Injects Widget                                        │ │
│  │ [Chat Interface] [DOM Observer] [Action Executor]      │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          ↕ HTTP
┌─────────────────────────────────────────────────────────────┐
│  API Server (Express + TypeScript)                          │
│  • Widget serving with site-specific config                 │
│  • Chat endpoint with streaming support                     │
│  • Conversation persistence (Supabase)                      │
│  • Rate limiting and authentication                         │
└─────────────────────────────────────────────────────────────┘
                          ↕
┌─────────────────────────────────────────────────────────────┐
│  LLM Provider (Gemini 2.5 Flash)                            │
│  • DOM → Actions reasoning                                  │
│  • Multi-turn conversation handling                         │
│  • Structured output parsing                                │
└─────────────────────────────────────────────────────────────┘
                          ↕
┌─────────────────────────────────────────────────────────────┐
│  Dashboard (Next.js 15)                                     │
│  • Site management and configuration                        │
│  • Real-time conversation monitoring                        │
│  • Action feed with timestamped logs                        │
│  • Embed code generation                                    │
└─────────────────────────────────────────────────────────────┘
```

## Tech Stack

**Backend**
- Express.js with TypeScript
- tsx for hot-reload development
- Supabase (PostgreSQL) for persistence
- Google Generative AI SDK

**Frontend**
- Next.js 15 with App Router
- React 19 (RC)
- TypeScript strict mode
- Tailwind CSS for styling

**Widget**
- Vanilla JavaScript (framework-agnostic)
- Shadow DOM for style isolation
- MutationObserver + PerformanceObserver APIs
- Lightweight bundle (~15KB gzipped)

## Setup

### Prerequisites
```bash
node >= 18.0.0
npm >= 9.0.0
```

### Environment Configuration

**apps/server/.env**:
```env
PORT=3001
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
CORS_ORIGIN=http://localhost:3000
```

**apps/web/.env.local**:
```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Installation

```bash
# Install dependencies
npm install

# Apply database migrations
# (import supabase/migrations/*.sql to your Supabase project)

# Start development
npm run dev
```

Servers:
- Dashboard: `http://localhost:3000`
- API: `http://localhost:3001`

## Usage

1. **Create a site** in the dashboard
2. **Copy the embed code**:
   ```html
   <script src="http://localhost:3001/embed?siteId=YOUR_SITE_ID"></script>
   ```
3. **Add to target website** (any HTML page)
4. **Chat widget appears** - users can interact immediately

## API Reference

### GET /embed
Serves the widget JavaScript with site-specific configuration.

**Query Parameters**:
- `siteId` (required): Site identifier from dashboard

**Response**: JavaScript bundle that injects chat interface

### POST /chat
Processes user messages and returns AI responses with executable actions.

**Request Body**:
```typescript
{
  message: string;
  siteId: string;
  conversationId?: string;
  domSnapshot: string;
  url: string;
  timestamp: number;
}
```

**Response**:
```typescript
{
  response: string;        // AI message to user
  actions: Action[];       // Structured actions to execute
  conversationId: string;
}
```

## Project Structure

```
apps/
├── web/                 # Next.js dashboard application
│   ├── src/app/        # App router pages
│   ├── src/components/ # React components
│   └── src/lib/        # Utilities and Supabase client
│
├── server/             # Express API server
│   ├── src/routes/    # API endpoints
│   ├── src/lib/       # Agent logic and utilities
│   └── src/widget.ts  # Embeddable widget code
│
├── decent/            # Stable reference implementation
├── copy*/             # Experimental branches and iterations
└── trashshsh/         # Performance testing experiments

supabase/
└── migrations/        # Database schema and indexes

test-*.html            # Local integration tests
```

## Key Files

- **`apps/server/src/widget.ts`** - DOM distillation and action execution
- **`apps/server/src/lib/agent.ts`** - LLM integration and prompt engineering
- **`apps/server/src/routes/chat.ts`** - API orchestration
- **`apps/web/src/app/dashboard/`** - Site management UI

## Development Notes

### Multiple Versions
This repository preserves multiple implementation approaches:
- **apps/decent/** - Baseline working implementation
- **apps/server/** - Current active development with Gemini integration
- **apps/copy*/** - Experimental DOM distillation strategies

This preserves architectural learning and allows A/B comparison of approaches.

### Migration History
- Originally built with OpenAI GPT-4
- Migrated to Google Gemini 2.5 Flash for cost optimization
- DOM distillation went through 4+ iterations to balance context and accuracy
- WSL compatibility required Turbopack integration

## Performance Characteristics

- **Cold start**: ~200ms (widget injection + first DOM distillation)
- **Action latency**: ~800ms (LLM inference + execution)
- **DOM distillation**: <50ms for typical pages
- **Bundle size**: 15KB gzipped (widget only)

## Known Limitations

- Shadow DOM support works but hasn't been tested exhaustively on all frameworks
- Rate limiting is currently per-site, not per-user
- Some dynamic sites with aggressive ID randomization may need selector tuning
- Modal detection uses heuristics (z-index, overlay patterns) - may miss custom implementations

## Roadmap

- [ ] Multi-model support (GPT-4, Claude, open source)
- [ ] Advanced element selectors (XPath, CSS, semantic)
- [ ] Action replay and undo
- [ ] Streaming responses for faster perceived latency
- [ ] Browser extension version
- [ ] Self-hosting deployment guide

## License

MIT
