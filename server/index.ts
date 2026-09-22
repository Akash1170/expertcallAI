import 'dotenv/config';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { transcripts } from '../src/data/transcripts';
import { citationFromSegment } from '../src/lib/citations';
import { GeminiEmbeddingProvider, DeterministicEmbeddingProvider } from '../src/lib/embeddings';
import { GeminiProvider, NOT_FOUND, validateAnalysis, validateGuideBatch, validateModelAnswer } from '../src/lib/llm';
import { parseAll } from '../src/lib/parser';
import { buildVectorIndex, type SegmentFilter } from '../src/lib/retrieval';
import { ResultCache } from '../src/lib/result-cache';
import { answerCacheKey, guideBatchCacheKey, PIPELINE_VERSION } from '../src/lib/cache-keys';
import { isRateLimit, retryAfterSeconds } from '../src/lib/rate-limit';
import type { TranscriptSegment } from '../src/types';

const port = Number(process.env.API_PORT ?? 8787);
const initializationStart = performance.now();
const parseStart = performance.now();
const segments = parseAll(transcripts);
const transcriptParsingMs = performance.now() - parseStart;
const modelName = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const embeddingModelName = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const embeddingProvider = process.env.GEMINI_API_KEY
  ? new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY, embeddingModelName)
  : new DeterministicEmbeddingProvider();
const llm = process.env.GEMINI_API_KEY ? new GeminiProvider(process.env.GEMINI_API_KEY, modelName) : undefined;
const indexPromise = buildVectorIndex(segments, embeddingProvider);
const resultCache = new ResultCache<unknown>();
const indexReady = indexPromise.then((index) => {
  console.log(`[PERF] startup transcriptParsing=${transcriptParsingMs.toFixed(1)}ms documentEmbeddingIndex=${(performance.now() - initializationStart - transcriptParsingMs).toFixed(1)}ms total=${(performance.now() - initializationStart).toFixed(1)}ms segments=${segments.length} embeddingCalls=${segments.filter((segment) => segment.speaker !== 'Interviewer').length}`);
  return index;
});

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  response.end(JSON.stringify(body));
}

function citationsFor(ids: string[], sourceSegments: TranscriptSegment[]) {
  const byId = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  return [...new Set(ids)].map((id) => {
    const segment = byId.get(id);
    return segment ? citationFromSegment(segment) : null;
  }).filter((citation) => citation !== null);
}

function fallbackAnswer(question: string, evidence: TranscriptSegment[]) {
  if (evidence.length === 0) return { answer: NOT_FOUND, segmentIds: [] };
  return { answer: `Based on these interviews, the retrieved evidence addresses this question across ${new Set(evidence.map((segment) => segment.market)).size} market(s).`, segmentIds: evidence.slice(0, 4).map((segment) => segment.id) };
}

function citationsByDocument(results: Array<{ documentId: string; segmentIds: string[]; answer: string }>) {
  return results.map((result) => ({
    documentId: result.documentId,
    answer: result.answer,
    citations: citationsFor(result.segmentIds, segments),
  }));
}

async function guideBatch(question: string) {
  const requestStart = performance.now();
  const key = guideBatchCacheKey(question);
  const cacheHit = resultCache.get(key) !== undefined;
  console.log(`[CACHE ${cacheHit || resultCache.hasInFlight(key) ? 'HIT' : 'MISS'}] ${key}`);
  return resultCache.getOrGenerate(key, async () => {
    const index = await indexReady;
    const retrievalStart = performance.now();
    const retrieved = await Promise.all(transcripts.map(async (transcript) => [transcript.id, await index.searchWithTiming(question, embeddingProvider, 8, { documentId: transcript.id })] as const));
    const retrievalMs = performance.now() - retrievalStart;
    const evidenceByDocument = new Map(retrieved.map(([documentId, timing]) => [documentId, timing.segments]));
    const retrievedCounts = Object.fromEntries(retrieved.map(([documentId, timing]) => [documentId, timing.segments.length]));
    const embeddingMs = retrieved.reduce((sum, [, timing]) => sum + timing.queryEmbeddingMs, 0);
    const rankingMs = retrieved.reduce((sum, [, timing]) => sum + timing.rankingMs, 0);
    const modelTiming = llm ? await llm.guideBatchWithTiming(question, evidenceByDocument) : {
      value: { experts: retrieved.map(([documentId, timing]) => ({ documentId, answer: fallbackAnswer(question, timing.segments).answer, segmentIds: timing.segments.slice(0, 4).map((segment) => segment.id) })) },
      evidencePreparationMs: 0, generationMs: 0, responseParsingMs: 0,
    };
    const validationStart = performance.now();
    const validated = validateGuideBatch(modelTiming.value, evidenceByDocument);
    const results = citationsByDocument(validated.experts);
    const citationCounts = Object.fromEntries(results.map((result) => [result.documentId, result.citations.length]));
    const citationValidationMs = performance.now() - validationStart;
    console.log(`[PERF] guide-batch cache=MISS embedding=${embeddingMs.toFixed(1)}ms retrieval=${rankingMs.toFixed(1)}ms retrievalWallClock=${retrievalMs.toFixed(1)}ms evidencePreparation=${modelTiming.evidencePreparationMs.toFixed(1)}ms geminiGeneration=${modelTiming.generationMs.toFixed(1)}ms responseParsing=${modelTiming.responseParsingMs.toFixed(1)}ms citationValidation=${citationValidationMs.toFixed(1)}ms total=${(performance.now() - requestStart).toFixed(1)}ms retrievedByDocument=${JSON.stringify(retrievedCounts)} citationsByDocument=${JSON.stringify(citationCounts)} embeddingCalls=${transcripts.length} generationCalls=${llm ? 1 : 0} semanticEmbeddings=${Boolean(process.env.GEMINI_API_KEY)} geminiGeneration=${Boolean(llm)} retry=false rateLimitBackoff=false`);
    return { experts: results, retrievedCounts };
  }, (result) => Boolean(result && typeof result === 'object' && 'experts' in result));
}

async function groundedAnswer(question: string, filter?: SegmentFilter) {
  const requestStart = performance.now();
  const key = answerCacheKey(question, filter);
  const cacheHit = resultCache.get(key) !== undefined;
  if (cacheHit || resultCache.hasInFlight(key)) console.log(`[CACHE HIT] ${key}`);
  else console.log(`[CACHE MISS] ${key}`);
  return resultCache.getOrGenerate(key, async () => {
    const index = await indexReady;
    const retrieval = await index.searchWithTiming(question, embeddingProvider, 8, filter);
    const evidence = retrieval.segments;
    if (evidence.length === 0) return { answer: NOT_FOUND, citations: [], confidence: 'none', retrievedCount: 0 };
    const modelTiming = llm ? await llm.answerWithTiming(question, evidence) : { value: fallbackAnswer(question, evidence), evidencePreparationMs: 0, generationMs: 0, responseParsingMs: 0 };
    const modelAnswer = modelTiming.value;
    const validationStart = performance.now();
    const validated = validateModelAnswer(modelAnswer, evidence);
    const citations = citationsFor(validated.segmentIds, segments);
    const citationValidationMs = performance.now() - validationStart;
    const totalMs = performance.now() - requestStart;
    const route = filter?.documentId ? 'guide' : 'ask';
    console.log(`[PERF] ${route} document=${filter?.documentId ?? 'all'} cache=MISS embedding=${retrieval.queryEmbeddingMs.toFixed(1)}ms retrieval=${retrieval.rankingMs.toFixed(1)}ms evidencePreparation=${modelTiming.evidencePreparationMs.toFixed(1)}ms geminiGeneration=${modelTiming.generationMs.toFixed(1)}ms responseParsing=${modelTiming.responseParsingMs.toFixed(1)}ms citationValidation=${citationValidationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms retrieved=${evidence.length} citations=${citations.length} embeddingCalls=1 generationCalls=${llm ? 1 : 0} semanticEmbeddings=${Boolean(process.env.GEMINI_API_KEY)} geminiGeneration=${Boolean(llm)} retry=false rateLimitBackoff=false`);
    return { answer: validated.answer, citations, confidence: validated.segmentIds.length ? (llm ? 'high' : 'medium') : 'none', retrievedCount: evidence.length };
  }, (result) => {
    const answerResult = result as { answer: string; retrievedCount: number };
    return answerResult.answer !== NOT_FOUND || answerResult.retrievedCount === 0;
  });
}

async function handle(pathname: string, payload: Record<string, unknown>) {
  if (pathname === '/api/ask') return groundedAnswer(String(payload.question ?? ''));
  if (pathname === '/api/guide') return guideBatch(String(payload.question ?? ''));
  if (pathname === '/api/analysis') {
    const key = `${PIPELINE_VERSION}|analysis|adoption barriers budgets ROI training clinical outcomes outlook purchasing timeline`;
    if (resultCache.get(key) !== undefined || resultCache.hasInFlight(key)) console.log(`[CACHE HIT] ${key}`);
    else console.log(`[CACHE MISS] ${key}`);
    return resultCache.getOrGenerate(key, async () => {
      const requestStart = performance.now();
      const index = await indexReady;
      const retrieval = await index.searchWithTiming('adoption barriers budgets ROI training clinical outcomes outlook purchasing timeline', embeddingProvider, 18);
      const evidence = retrieval.segments;
      const modelTiming = llm ? await llm.analysisWithTiming(evidence) : { value: [], evidencePreparationMs: 0, generationMs: 0, responseParsingMs: 0 };
      const validationStart = performance.now();
      const items = llm ? validateAnalysis(modelTiming.value, segments) : [];
      const citations = items.flatMap((item) => citationsFor(item.segmentIds, segments));
      const citationValidationMs = performance.now() - validationStart;
      console.log(`[PERF] analysis cache=MISS embedding=${retrieval.queryEmbeddingMs.toFixed(1)}ms retrieval=${retrieval.rankingMs.toFixed(1)}ms evidencePreparation=${modelTiming.evidencePreparationMs.toFixed(1)}ms geminiGeneration=${modelTiming.generationMs.toFixed(1)}ms responseParsing=${modelTiming.responseParsingMs.toFixed(1)}ms citationValidation=${citationValidationMs.toFixed(1)}ms total=${(performance.now() - requestStart).toFixed(1)}ms retrieved=${evidence.length} citations=${citations.length} embeddingCalls=1 generationCalls=${llm ? 1 : 0} semanticEmbeddings=${Boolean(process.env.GEMINI_API_KEY)} geminiGeneration=${Boolean(llm)} retry=false rateLimitBackoff=false`);
      return { items: items.map((item) => ({ ...item, citations: citationsFor(item.segmentIds, segments) })), retrievedCount: evidence.length };
    });
  }
  if (pathname === '/api/health') return { status: 'ok', semanticEmbeddings: Boolean(process.env.GEMINI_API_KEY), llm: Boolean(llm), model: llm?.modelName ?? null, embeddingModel: embeddingProvider instanceof GeminiEmbeddingProvider ? embeddingProvider.modelName : null, segmentCount: segments.length, answerCacheEntries: resultCache.size, pipelineVersion: PIPELINE_VERSION };
  return null;
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {});
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  if (request.method === 'GET' && url.pathname === '/api/health') return handle('/api/health', {}).then((body) => json(response, 200, body));
  if (request.method !== 'POST') return json(response, 404, { error: 'Not found' });
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    try {
      const result = await handle(url.pathname, JSON.parse(body || '{}'));
      if (!result) return json(response, 404, { error: 'Not found' });
      return json(response, 200, result);
    } catch (error) {
      if (isRateLimit(error)) {
        const retryAfter = retryAfterSeconds(error);
        console.error(`[GEMINI_RATE_LIMIT] retryAfterSeconds=${retryAfter ?? 'unknown'}`);
        return json(response, 429, { error: 'AI service rate limit reached.', ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}) });
      }
      console.error(`[GEMINI_REQUEST_FAILED] ${error instanceof Error ? error.message : 'unknown error'}`);
      return json(response, 500, { error: 'The grounded analysis request failed.' });
    }
  });
});

server.listen(port, () => console.log(`ExpertCall API listening on http://localhost:${port} (${llm ? 'Gemini' : 'no-key fallback'})`));
