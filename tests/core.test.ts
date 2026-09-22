import { describe, expect, it } from 'vitest';
import { transcripts } from '../src/data/transcripts';
import { citationFromSegment, verifyQuote } from '../src/lib/citations';
import { DeterministicEmbeddingProvider } from '../src/lib/embeddings';
import { NOT_FOUND, validateAnalysis, validateGuideBatch, validateModelAnswer } from '../src/lib/llm';
import { parseAll, parseTranscript } from '../src/lib/parser';
import { buildVectorIndex, cosineSimilarity, retrieve } from '../src/lib/retrieval';
import { ResultCache } from '../src/lib/result-cache';
import { isRateLimit, retryAfterSeconds } from '../src/lib/rate-limit';
import { answerCacheKey, guideBatchCacheKey, PIPELINE_VERSION } from '../src/lib/cache-keys';

const segments = parseAll(transcripts);

describe('transcript ingestion', () => {
  it('parses timestamp, speaker, text and metadata', () => {
    const france = parseTranscript(transcripts[0]);
    expect(france).toHaveLength(14);
    expect(france[1]).toMatchObject({ timestamp: '00:18', speaker: 'Dr. Martin', market: 'France', expert: 'Dr. Jean Martin' });
    expect(france[1].seconds).toBe(18);
  });
  it('preserves all source documents and metadata', () => {
    expect(segments).toHaveLength(42);
    expect(new Set(segments.map((segment) => segment.documentId))).toEqual(new Set(['france-01', 'germany-02', 'uk-03']));
  });
});

describe('citation verification', () => {
  const segment = parseTranscript(transcripts[0])[1];
  it('accepts only verbatim source text', () => {
    expect(verifyQuote('Adoption is growing', segment)).toBe(true);
    expect(verifyQuote('Adoption is shrinking', segment)).toBe(false);
    expect(citationFromSegment(segment, 'invented')).toBe(null);
  });
});

describe('semantic retrieval utilities', () => {
  it('calculates cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it('supports deterministic hybrid retrieval and metadata filtering', async () => {
    const index = await buildVectorIndex(segments, new DeterministicEmbeddingProvider());
    const results = await index.search('What are the barriers to adoption?', new DeterministicEmbeddingProvider(), 3, { market: 'Germany' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((segment) => segment.market === 'Germany')).toBe(true);
    expect(results.every((segment) => segment.speaker !== 'Interviewer')).toBe(true);
  });
  it('retains lexical utility for deterministic evaluation', () => expect(retrieve('barriers training', segments).length).toBeGreaterThan(0));
  it('does not treat generic shared words as evidence for an unrelated question', async () => {
    const index = await buildVectorIndex(segments, new DeterministicEmbeddingProvider());
    expect(await index.search('What reimbursement tax policy does the EU use for robotic surgery?', new DeterministicEmbeddingProvider())).toHaveLength(0);
  });
  it('retrieves German economic and total-cost evidence for an ROI concept', () => {
    const results = retrieve('total cost ownership procedure volume maintenance service economic case', segments, 8);
    expect(results.some((segment) => segment.id === 'germany-02-6')).toBe(true);
  });
  it('retrieves purchasing timeline evidence from multiple markets', () => {
    const results = retrieve('purchase month', segments, 8);
    expect(new Set(results.map((segment) => segment.market))).toEqual(new Set(['France', 'Germany', 'United Kingdom']));
  });
  it('retrieves comparative training evidence from multiple experts', () => {
    const results = retrieve('training utilisation', segments, 8);
    expect(new Set(results.map((segment) => segment.expert)).size).toBeGreaterThan(1);
  });
});

describe('model output validation', () => {
  it('rejects unknown segment IDs and derives not-found when no IDs remain', () => {
    expect(validateModelAnswer({ answer: 'unsupported', segmentIds: ['made-up-id'] }, segments)).toEqual({ answer: NOT_FOUND, segmentIds: [] });
  });
  it('filters unsupported analysis citations', () => {
    const valid = validateAnalysis([{ type: 'agreement', title: 'Theme', synthesis: 'Evidence', segmentIds: [segments[1].id, 'fake'] }], segments);
    expect(valid[0].segmentIds).toEqual([segments[1].id]);
  });
  it('validates Guide batch citations within each document boundary', () => {
    const evidenceByDocument = new Map([
      ['france-01', segments.filter((segment) => segment.documentId === 'france-01').filter((segment) => segment.speaker !== 'Interviewer').slice(0, 1)],
      ['germany-02', segments.filter((segment) => segment.documentId === 'germany-02').filter((segment) => segment.speaker !== 'Interviewer').slice(0, 1)],
      ['uk-03', segments.filter((segment) => segment.documentId === 'uk-03').filter((segment) => segment.speaker !== 'Interviewer').slice(0, 1)],
    ]);
    const result = validateGuideBatch({ experts: [
      { documentId: 'france-01', answer: 'wrong boundary', segmentIds: ['germany-02-6'] },
      { documentId: 'germany-02', answer: 'wrong boundary', segmentIds: ['uk-03-2'] },
      { documentId: 'uk-03', answer: 'wrong boundary', segmentIds: ['france-01-2'] },
    ] }, evidenceByDocument);
    expect(result.experts.find((expert) => expert.documentId === 'france-01')?.answer).toBe(NOT_FOUND);
    expect(result.experts.find((expert) => expert.documentId === 'france-01')?.segmentIds).toEqual([]);
    expect(result.experts.find((expert) => expert.documentId === 'germany-02')?.segmentIds).toEqual([]);
    expect(result.experts.find((expert) => expert.documentId === 'uk-03')?.segmentIds).toEqual([]);
  });
});

describe('grounded result caching', () => {
  it('caches successful results and shares in-flight generation', async () => {
    const cache = new ResultCache<string>();
    let calls = 0;
    const generate = async () => { calls += 1; await Promise.resolve(); return 'answer'; };
    const [first, second] = await Promise.all([cache.getOrGenerate('same', generate), cache.getOrGenerate('same', generate)]);
    expect([first, second]).toEqual(['answer', 'answer']);
    expect(calls).toBe(1);
    expect(await cache.getOrGenerate('same', generate)).toBe('answer');
    expect(calls).toBe(1);
  });
  it('does not cache failed requests or conflate different keys', async () => {
    const cache = new ResultCache<string>();
    let calls = 0;
    await expect(cache.getOrGenerate('failed', async () => { calls += 1; throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(cache.getOrGenerate('failed', async () => { calls += 1; throw new Error('failed again'); })).rejects.toThrow('failed again');
    expect(calls).toBe(2);
    await cache.getOrGenerate('expert-france', async () => 'france');
    await cache.getOrGenerate('expert-germany', async () => 'germany');
    expect(cache.size).toBe(2);
  });
  it('isolates pipeline versions and filters in answer keys', () => {
    const france = answerCacheKey('What does ROI mean?', { documentId: 'france-01' });
    const germany = answerCacheKey('What does ROI mean?', { documentId: 'germany-02' });
    expect(france).not.toBe(germany);
    expect(france.startsWith(`${PIPELINE_VERSION}|answer|`)).toBe(true);
    expect(guideBatchCacheKey('same question')).not.toBe(answerCacheKey('same question'));
    expect(guideBatchCacheKey('same question')).toContain(`${PIPELINE_VERSION}|guide-batch|`);
  });
});

describe('Gemini rate-limit mapping', () => {
  it('detects 429 variants and preserves Retry-After seconds', () => {
    expect(isRateLimit({ status: 429 })).toBe(true);
    expect(isRateLimit({ statusCode: 429 })).toBe(true);
    expect(isRateLimit({ error: { code: 'too_many_requests' } })).toBe(true);
    expect(retryAfterSeconds({ headers: new Headers({ 'retry-after': '51' }) })).toBe(51);
  });
});
