import type { TranscriptSegment } from '../types';

const stopWords = new Set('the a an and or of to in is are it this that for on with from but how what where which do does will would can could has have be by into about over under across use you your'.split(' '));
const genericDomainTerms = new Set('robotic surgery expert market hospital system technology procedure'.split(' '));
const canonicalTerms: Record<string, string> = { purchasing: 'purchase', procurement: 'purchase', purchased: 'purchase', timeline: 'month', months: 'month', decisions: 'process', decision: 'process', making: 'process' };
export const tokens = (value: string) => value.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').split(/\s+/).map((token) => canonicalTerms[token] ?? token).filter((token) => token.length > 2 && !stopWords.has(token));

export interface SegmentFilter {
  expert?: string;
  market?: string;
  documentId?: string;
}

export interface EmbeddingProvider {
  embed(text: string, taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT'): Promise<number[]>;
  readonly isDeterministicFallback?: boolean;
}

export interface IndexedSegment {
  segment: TranscriptSegment;
  embedding: number[];
}

export interface RetrievalTiming {
  segments: TranscriptSegment[];
  queryEmbeddingMs: number;
  rankingMs: number;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return leftMagnitude && rightMagnitude ? dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)) : 0;
}

function lexicalScore(question: string, segment: TranscriptSegment): number {
  const queryTerms = new Set(tokens(question));
  const segmentTerms = new Set(tokens(`${segment.text} ${segment.speaker} ${segment.market}`));
  if (queryTerms.size === 0) return 0;
  return [...queryTerms].filter((term) => segmentTerms.has(term)).length / queryTerms.size;
}

function matchesFilter(segment: TranscriptSegment, filter?: SegmentFilter): boolean {
  return (!filter?.expert || segment.expert === filter.expert)
    && (!filter?.market || segment.market === filter.market)
    && (!filter?.documentId || segment.documentId === filter.documentId);
}

export class InMemoryVectorIndex {
  constructor(private readonly entries: IndexedSegment[]) {}

  async search(question: string, embedder: EmbeddingProvider | undefined, limit = 8, filter?: SegmentFilter): Promise<TranscriptSegment[]> {
    return (await this.searchWithTiming(question, embedder, limit, filter)).segments;
  }

  async searchWithTiming(question: string, embedder: EmbeddingProvider | undefined, limit = 8, filter?: SegmentFilter): Promise<RetrievalTiming> {
    const candidates = this.entries.filter(({ segment }) => segment.speaker !== 'Interviewer' && matchesFilter(segment, filter));
    const embeddingStart = performance.now();
    const queryEmbedding = embedder ? await embedder.embed(question, 'RETRIEVAL_QUERY') : undefined;
    const queryEmbeddingMs = performance.now() - embeddingStart;
    const rankingStart = performance.now();
    const queryTerms = new Set(tokens(question));
    const sourceTerms = new Set(candidates.flatMap(({ segment }) => tokens(`${segment.text} ${segment.speaker} ${segment.market} ${segment.role}`)));
    const hasSourceVocabulary = [...queryTerms].some((term) => !genericDomainTerms.has(term) && sourceTerms.has(term));
    if (!hasSourceVocabulary && (!queryEmbedding || embedder?.isDeterministicFallback)) return { segments: [], queryEmbeddingMs, rankingMs: performance.now() - rankingStart };
    const segments = candidates.map(({ segment, embedding }) => {
      const semantic = queryEmbedding && !embedder?.isDeterministicFallback ? cosineSimilarity(queryEmbedding, embedding) : 0;
      const keyword = lexicalScore(question, segment);
      const score = embedder?.isDeterministicFallback ? keyword : queryEmbedding ? (semantic * 0.8) + (keyword * 0.2) : keyword;
      return { segment, semantic, keyword, score };
    }).filter(({ semantic, keyword }) => keyword >= 0.15 || semantic >= 0.45).sort((left, right) => right.score - left.score).slice(0, limit).map(({ segment }) => segment);
    return { segments, queryEmbeddingMs, rankingMs: performance.now() - rankingStart };
  }
}

export async function buildVectorIndex(segments: TranscriptSegment[], embedder: EmbeddingProvider): Promise<InMemoryVectorIndex> {
  const expertSegments = segments.filter((segment) => segment.speaker !== 'Interviewer');
  const entries = await Promise.all(expertSegments.map(async (segment) => ({ segment, embedding: await embedder.embed(segment.text, 'RETRIEVAL_DOCUMENT') })));
  return new InMemoryVectorIndex(entries);
}

export function retrieve(question: string, segments: TranscriptSegment[], limit = 8): TranscriptSegment[] {
  const queryTerms = tokens(question);
  const scored = segments.filter((segment) => segment.speaker !== 'Interviewer').map((segment) => {
    const textTerms = tokens(`${segment.text} ${segment.speaker} ${segment.market}`);
    const score = queryTerms.reduce((total, term) => total + (textTerms.includes(term) ? 1 : 0), 0);
    return { segment, score };
  }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score);
  return scored.slice(0, limit).map(({ segment }) => segment);
}

export function relevance(question: string, segments: TranscriptSegment[]): number {
  const queryTerms = tokens(question);
  if (queryTerms.length === 0 || segments.length === 0) return 0;
  const matched = new Set(segments.flatMap((segment) => tokens(segment.text)));
  return queryTerms.filter((term) => matched.has(term)).length / queryTerms.length;
}
