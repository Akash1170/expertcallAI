# ExpertCall AI - Project Handoff

## 1. Project purpose

ExpertCall AI is a source-first AI Engineer case-study application for analysing three expert calls about the European robotic surgery market. The project demonstrates grounded retrieval, structured Gemini generation, exact source citations, timestamp traceability, refusal of unsupported questions, and a practical scaling story.

The authoritative source material covers France, Germany, and the United Kingdom. The application is intended for a short technical interview demonstration rather than a production-scale platform.

## 2. Assignment requirements

The assignment requires the application to:

- Read and analyse three expert transcripts.
- Answer six interview-guide questions for each expert.
- Preserve timestamps, expert identity, role, market, speaker, document ID, and original text.
- Show exact useful quotations with source timestamps.
- Identify common themes, agreements, meaningful disagreements, and market differences.
- Provide Ask Across Transcripts grounded Q&A.
- Avoid invented answers, quotes, timestamps, citations, and market-wide generalizations.
- Return `Not found in the provided transcripts.` when evidence is insufficient.
- Explain model choice, architecture, hallucination controls, and scaling from 3 to 30+ transcripts.
- Include a working local application, source repository, README, tests, evaluation scripts, and deployment/run instructions.

The current source parser produces 42 timestamped segments: 21 interviewer segments and 21 expert-answer segments.

## 3. Current architecture

```text
Transcripts
   |
   v
Parser
   |
   v
Timestamped segments + document/expert/market metadata
   |
   v
Gemini embeddings (server-side)
   |
   v
In-memory vector index
   |
   v
Hybrid retrieval: semantic cosine similarity + lexical overlap
   |
   v
Retrieved evidence
   |
   v
Gemini grounded generation through Interactions API
   |
   v
Structured segment IDs
   |
   v
Server-side segment/document validation
   |
   v
Exact quote/timestamp/source lookup from original transcript
   |
   v
Frontend answer and citation cards
```

The frontend is React/Vite/TypeScript. The backend is a small native Node HTTP server in `server/index.ts`. The server owns embedding calls, retrieval, Gemini generation, structured-output parsing, citation validation, caching, and rate-limit responses. The browser never receives the Gemini API key.

Important current modules:

- `src/lib/parser.ts`: timestamp and speaker parsing.
- `src/lib/embeddings.ts`: Gemini embedding adapter and deterministic no-key test fallback.
- `src/lib/retrieval.ts`: vector index, cosine similarity, lexical scoring, hybrid ranking, and metadata filters.
- `src/lib/llm.ts`: Gemini generation, Guide batch schema, Ask schema, Analysis schema, and segment-ID validation.
- `src/lib/citations.ts`: exact quote validation and source-derived citation construction.
- `src/lib/cache-keys.ts`: versioned cache key construction.
- `src/lib/result-cache.ts`: process-local successful-result cache and in-flight deduplication.
- `src/lib/rate-limit.ts`: sanitized 429 and Retry-After helpers.
- `server/index.ts`: `/api/guide`, `/api/ask`, `/api/analysis`, and `/api/health`.

## 4. Models and SDK

Current dependency:

- `@google/genai`: `2.24.0`

Server-side environment-controlled models:

- Generation model: `GEMINI_MODEL`, default `gemini-3.5-flash-lite`.
- Embedding model: `GEMINI_EMBEDDING_MODEL`, default `gemini-embedding-001`.

Generation mechanism:

- `GoogleGenAI` from `@google/genai`.
- `client.interactions.create(...)` through the Gemini Interactions API.
- `store: false` is explicitly used for stateless requests.
- Structured JSON is enabled using `response_format` with JSON MIME type and schemas for Ask, Guide batch, and Analysis.

Embedding mechanism:

- `client.models.embedContent(...)`.
- Document segments use task type `RETRIEVAL_DOCUMENT`.
- Query embeddings use task type `RETRIEVAL_QUERY`.

Generation configuration inspected statically:

- Streaming: not enabled.
- Thinking/reasoning: not explicitly configured.
- The model may therefore use its own provider/model default behavior for thinking or reasoning.
- Maximum output tokens: not configured.
- Temperature: not configured in the current Interactions request. The application does not set a generation temperature.
- Timeout: no application-level Gemini generation timeout is configured.
- SDK retry configuration: no explicit SDK retry configuration is set in project code.
- Server retry/backoff: no generation retry loop or backoff loop exists. 429 errors are mapped to HTTP 429 and a sanitized `retryAfterSeconds` value when available.
- Tool calls: none are requested. No Google Search, function, code execution, or other Gemini tools are enabled.
- Conversation/history: no previous interaction ID is sent, and `store:false` is used. Each request is stateless and includes only the current question plus retrieved evidence.

Approximate serialized evidence payload sizes measured from current source formatting:

- Ask: about 2,562 characters for the measured sample evidence block.
- Guide batch: about 6,761 characters for the three document-scoped evidence blocks.
- Cross-Expert Analysis: about 5,756 characters for the current evidence block.

These are small case-study payloads. The measured latency is not explained by retrieval or payload size alone; Gemini generation dominates.

## 5. Retrieval details

- Only expert-answer segments are eligible as answer evidence; interviewer prompts are excluded.
- The current vector index is in memory and built once at server startup.
- Document embeddings are generated once for the 21 expert-answer segments during startup.
- Each query receives one embedding per retrieval operation.
- Cosine similarity is computed as:

```text
cos(a, b) = (a dot b) / (||a|| * ||b||)
```

- Gemini semantic score contributes 80%.
- Lexical token-overlap score contributes 20%.
- The acceptance rule is `keyword >= 0.15 OR semantic >= 0.45` for semantic Gemini retrieval.
- Default top-K is 8 for Ask and per-document Guide retrieval.
- Cross-Expert Analysis retrieves up to 18 segments.
- Guide retrieval is document-specific for `france-01`, `germany-02`, and `uk-03`.
- Ask supports document/expert/market filters through the server retrieval interface, although the standard Ask UI uses the global search.
- The deterministic embedding and lexical fallback exist for no-key local tests only; they are not the real semantic production path.

## 6. Interview Guide

The current Guide architecture is batched.

For one selected question:

1. The frontend sends one `POST /api/guide` request with the question.
2. The server independently retrieves evidence for France, Germany, and the UK using document filters.
3. Retrieved evidence is combined with explicit document IDs.
4. One Gemini structured generation call returns one result per document.
5. Each returned document ID and segment ID is validated against that document's evidence only.
6. Exact quotes, timestamps, expert, market, and source metadata are derived from original transcript segments.
7. The frontend populates the existing France, Germany, and UK cards.

Each expert can independently return `Not found in the provided transcripts.` without suppressing valid results for other experts.

The previous architecture used three separate Guide generations. That is historical context only and is not the current implementation.

## 7. Ask Across Calls

Ask flow:

```text
User question
  -> one query embedding
  -> global hybrid retrieval
  -> top evidence
  -> one grounded Gemini Interactions request
  -> structured answer + segment IDs
  -> segment-ID validation
  -> original source citation construction
  -> frontend answer and citations
```

The model can synthesize the answer, but cannot author authoritative quotes, timestamps, or metadata. Those are obtained from the source segment store.

Unsupported questions return `Not found in the provided transcripts.` when no accepted evidence exists. Retrieved evidence-backed model refusals are not persisted by the single-answer cache when evidence was available.

## 8. Cross-Expert Analysis

The Analysis page sends one `POST /api/analysis` request. The server:

1. Retrieves up to 18 cross-transcript evidence segments.
2. Sends the evidence to one Gemini structured generation request.
3. Expects items typed as agreement, disagreement, or difference.
4. Validates every returned segment ID against the full source segment store.
5. Derives all displayed citations from original transcript data.

The model is instructed not to claim disagreements unless the supplied interviews support different positions and not to generalize beyond the three interviews.

## 9. Citation safety

The model returns segment IDs, not trusted quote text or timestamps.

For each returned ID, the server:

1. Checks that the ID exists in the retrieved/source segment set.
2. For Guide results, checks that the ID belongs to the result's required document.
3. Deduplicates IDs.
4. Looks up original text and metadata by ID.
5. Uses `citationFromSegment` and exact substring validation.
6. Returns the original transcript text as the quote.

The authoritative citation fields are therefore:

- original segment text
- original timestamp
- original expert
- original market
- original document ID/source

## 10. Unsupported questions

The exact refusal string is:

```text
Not found in the provided transcripts.
```

It is used when retrieval produces no accepted evidence, or when model-returned segment IDs are invalid/empty after validation. The server does not invent a citation to make an answer appear complete.

## 11. Cache behavior

The cache is in memory and process-local.

Current cache key families include the pipeline version:

- Single-answer: `grounded-rag-v2|answer|normalized-question|filters`
- Guide batch: `grounded-rag-v2|guide-batch|normalized-question`
- Analysis: `grounded-rag-v2|analysis|...`

The cache also tracks in-flight Promises so identical concurrent requests share one generation.

Cache behavior:

- Successful validated results are cacheable.
- Failed requests and thrown errors are not cached.
- The single-answer path does not cache a model-generated `Not found` when retrieved evidence existed.
- Genuine no-evidence refusals may be cached.
- The current Guide batch cacheability predicate caches structurally valid batch results, including per-expert `Not found` values. Per-document validation still occurs before caching; this is a known area to review if stricter per-expert cache semantics are required.
- Restarting the Node server clears all cached results and in-flight state.
- `/api/health` exposes non-sensitive `answerCacheEntries` and `pipelineVersion` diagnostics.

## 12. Performance measurements

Measured controlled Ask request:

- Total: approximately 25.19 seconds.
- Query embedding: approximately 0.94 seconds.
- Retrieval: approximately 4.6 ms.
- Gemini generation: approximately 24.24 seconds.
- Citation validation: approximately 0.2 ms.
- One query embedding call and one generation call.

Measured Cross-Expert Analysis:

- Total: approximately 23.48 seconds.
- Query embedding: approximately 0.80 seconds in the later instrumentation run.
- Retrieval/ranking: approximately 1.7 ms.
- Gemini generation: approximately 22.69 seconds.
- One embedding call and one generation call.

Measured old Guide architecture:

- Three `/api/guide` requests and three Gemini generations.
- Overall controlled wall-clock: approximately 73.38 seconds.
- Individual generations ranged from approximately 21 to 73 seconds.

Measured current batched Guide architecture:

- One `/api/guide` request.
- Three expert-specific query embeddings.
- Three document-scoped retrievals.
- One Gemini generation.
- Fresh controlled wall-clock: approximately 63.03 seconds.
- Retrieved evidence: 7 segments per document.
- Citations: 1 per document, all document-correct.
- Earlier instrumentation recorded roughly 2.29 seconds total embedding time and approximately 62.13 seconds generation time. The evidence-preparation timing field was corrected afterward so it no longer includes generation time.

The consistent conclusion is:

```text
Retrieval itself is milliseconds.
Gemini generation is the dominant latency source.
```

## 13. Important bugs already fixed

- Replaced the original lexical/template-only implementation with real server-side Gemini and embeddings.
- Migrated from the retired `@google/generative-ai` package/model path to `@google/genai` and Interactions API.
- Added semantic embeddings, cosine similarity, and hybrid retrieval.
- Fixed stale `Not found` cache poisoning by versioning cache keys and restricting single-answer caching when evidence existed.
- Added cache hit/miss diagnostics and in-flight deduplication.
- Fixed the Guide `useEffect` repeated-fetch loop.
- Fixed Guide requests being triggered outside the Guide view.
- Fixed frontend answer cache keys so questions cannot reuse another question's results.
- Added request cancellation and stale-response protection.
- Added sanitized free-tier 429 handling and Retry-After messaging.
- Added server/client performance instrumentation.
- Replaced the old three-generation Guide architecture with one batched, document-scoped generation.
- Added strict per-document Guide segment-ID validation.

## 14. Tests

Current deterministic test count: **17 tests passed** in the last verified run.

Coverage includes:

- Transcript parsing and timestamps.
- Metadata preservation across 42 segments and 3 documents.
- Exact quote validation.
- Cosine similarity and deterministic retrieval.
- Metadata filtering.
- Unsupported evidence gating.
- ROI/economic-case retrieval concepts.
- Timeline retrieval across markets.
- Comparative multi-expert retrieval.
- Guide batch document-boundary validation.
- Cache hits, in-flight deduplication, failed-request behavior, and key isolation.
- Pipeline-versioned cache keys.
- 429 detection and Retry-After parsing.

The deterministic test suite never requires a live Gemini call.

## 15. Environment

Variable names only:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `GEMINI_EMBEDDING_MODEL`
- `API_PORT`

The real key belongs only in a local `.env`. `.env` is ignored by Git and must not be committed, archived, or shared.

## 16. Running locally

Install dependencies:

```powershell
npm install
```

Create local environment configuration from the placeholder file, then set the server-only key:

```powershell
Copy-Item .env.example .env
```

Run frontend and API together:

```powershell
npm run dev:all
```

Run API only:

```powershell
npm run dev:api
```

Run frontend only:

```powershell
npm run dev
```

Run deterministic tests:

```powershell
npm test
```

Build:

```powershell
npm run build
```

The package also contains `npm run evaluate`, `scripts/live-evaluate.ts`, and `scripts/probe-gemini.ts`. These can consume Gemini quota when configured, so use them intentionally and do not run them as normal CI checks.

## 17. Submission status

- [ ] final UI smoke test
- [ ] verify health endpoint
- [ ] verify `.env` excluded
- [ ] verify ZIP/repository contains no secrets
- [ ] final README review
- [ ] record demo video
- [ ] push final Git commit
- [ ] create final submission ZIP if required
- [ ] complete Hasamex submission form

No checklist item is marked complete by this handoff document.

## 18. Demo plan

A concise approximately five-minute demo:

1. Open Overview and explain the source-first research workspace.
2. Open Interview Guide and select one question to show the batched France/Germany/UK answers and exact evidence.
3. Open Cross-Expert Analysis and show agreements/differences with citations.
4. Open Ask Across Calls and ask one supported cross-transcript question.
5. Ask an unsupported question and show the exact `Not found in the provided transcripts.` response.
6. Explain parser -> embeddings -> hybrid retrieval -> grounded Gemini -> segment validation -> source citation.
7. Explain hallucination protection: evidence gate, segment IDs, document boundaries, exact source-derived quotes/timestamps.
8. Explain scaling from 3 to 30+ transcripts.

Cached results may be used during a recorded demo to avoid waiting on free-tier latency, but they must be genuine previously generated and validated results, never hardcoded answers.

## 19. Known limitations

- Gemini free-tier/provider latency can dominate the user experience.
- Gemini rate limits can produce HTTP 429 responses.
- The cache is process-local and resets when the API restarts.
- The vector index is in memory and appropriate for this 3-transcript case study, not a production corpus.
- The supplied transcript data is currently embedded in `src/data/transcripts.ts` rather than loaded through a production upload pipeline.
- There is no application-level Gemini generation timeout.
- The current SDK request does not explicitly configure temperature, thinking controls, maximum output tokens, or retry policy; provider/model defaults apply where applicable.
- Production scaling would use persistent vector storage, durable ingestion, batch embeddings, caching, reranking, access controls, observability, and evaluation monitoring.

## 20. Safe next steps

1. Submission readiness: run the final UI smoke test, confirm health, inspect the README, and verify `.env`/secret exclusions.
2. Prepare a short demo script and record the architecture/citation explanation.
3. Create the final archive only after checking that no previous archive, build output, dependencies, or secrets are included.
4. Do not change the generation path or model immediately before submission unless a new blocker appears.
5. After submission, consider a bounded Gemini timeout and explicit generation configuration as a separate, measured performance task.
