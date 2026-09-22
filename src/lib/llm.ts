import { GoogleGenAI } from '@google/genai';
import type { TranscriptSegment } from '../types';

export const NOT_FOUND = 'Not found in the provided transcripts.';

export interface ModelAnswer {
  answer: string;
  segmentIds: string[];
}

export interface GuideExpertAnswer {
  documentId: string;
  answer: string;
  segmentIds: string[];
}

export interface GuideBatchAnswer {
  experts: GuideExpertAnswer[];
}

export interface AnalysisItem {
  type: 'agreement' | 'disagreement' | 'difference';
  title: string;
  synthesis: string;
  segmentIds: string[];
}

export interface GenerationTiming<T> {
  value: T;
  evidencePreparationMs: number;
  generationMs: number;
  responseParsingMs: number;
}

const answerSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    segmentIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'segmentIds'],
};

const analysisSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['agreement', 'disagreement', 'difference'] },
      title: { type: 'string' },
      synthesis: { type: 'string' },
      segmentIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'title', 'synthesis', 'segmentIds'],
  },
};

const guideBatchSchema = {
  type: 'object',
  properties: {
    experts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          documentId: { type: 'string' },
          answer: { type: 'string' },
          segmentIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['documentId', 'answer', 'segmentIds'],
      },
    },
  },
  required: ['experts'],
};

function evidenceBlock(segments: TranscriptSegment[]): string {
  return segments.map((segment) => [
    `SEGMENT_ID: ${segment.id}`,
    `EXPERT: ${segment.expert}`,
    `ROLE: ${segment.role}`,
    `MARKET: ${segment.market}`,
    `TIMESTAMP: ${segment.timestamp}`,
    `SPEAKER: ${segment.speaker}`,
    `TEXT: ${segment.text}`,
  ].join('\n')).join('\n\n');
}

function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned) as T;
}

export class GeminiProvider {
  private readonly client: GoogleGenAI;
  readonly modelName: string;

  constructor(apiKey: string, modelName = 'gemini-3.5-flash-lite') {
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
  }

  private async generate<T>(input: string, schema: object): Promise<T> {
    return (await this.generateWithTiming<T>(input, schema)).value;
  }

  private async generateWithTiming<T>(input: string, schema: object): Promise<GenerationTiming<T>> {
    const generationStart = performance.now();
    const interaction = await this.client.interactions.create({
      model: this.modelName,
      input,
      store: false,
      system_instruction: 'Return only valid JSON matching the supplied response schema. Use only the supplied transcript evidence.',
      response_format: { type: 'text', mime_type: 'application/json', schema },
    });
    const generationMs = performance.now() - generationStart;
    if (!interaction.output_text) throw new Error('Gemini returned an empty interaction output.');
    const parsingStart = performance.now();
    const value = parseJson<T>(interaction.output_text);
    return { value, evidencePreparationMs: 0, generationMs, responseParsingMs: performance.now() - parsingStart };
  }

  async answer(question: string, segments: TranscriptSegment[]): Promise<ModelAnswer> {
    return (await this.answerWithTiming(question, segments)).value;
  }

  async guideBatch(question: string, evidenceByDocument: Map<string, TranscriptSegment[]>): Promise<GuideBatchAnswer> {
    return (await this.guideBatchWithTiming(question, evidenceByDocument)).value;
  }

  async guideBatchWithTiming(question: string, evidenceByDocument: Map<string, TranscriptSegment[]>): Promise<GenerationTiming<GuideBatchAnswer>> {
    const evidencePreparationStart = performance.now();
    const evidence = [...evidenceByDocument.entries()].map(([documentId, documentSegments]) => `DOCUMENT: ${documentId}\n${evidenceBlock(documentSegments)}`).join('\n\n');
    const evidencePreparationMs = performance.now() - evidencePreparationStart;
    const input = `Answer this interview-guide question separately for each supplied document. Use ONLY evidence belonging to that document. If one document has insufficient evidence, return "${NOT_FOUND}" for that document with an empty segmentIds array; do not suppress answers for other documents. Return JSON matching the schema with one result per supplied document. Copy document IDs and segment IDs exactly. Never create quotes, timestamps, experts, or markets.\n\nQUESTION: ${question}\n\nDOCUMENT-SCOPED EVIDENCE:\n${evidence}`;
    return { ...(await this.generateWithTiming<GuideBatchAnswer>(input, guideBatchSchema)), evidencePreparationMs };
  }

  async answerWithTiming(question: string, segments: TranscriptSegment[]): Promise<GenerationTiming<ModelAnswer>> {
    const evidenceStart = performance.now();
    const input = `Answer the question using ONLY the supplied transcript evidence. Do not use outside knowledge. Use reasonable language matching: for example, ROI/economics/financial case and training/utilisation may refer to the same source concepts when the evidence supports that interpretation. For comparative questions, compare the supplied experts directly when the evidence supports a comparison. Return exactly "${NOT_FOUND}" with an empty segmentIds array only when none of the supplied evidence addresses the question. Segment IDs must be copied exactly from the evidence. Never create quotes, timestamps, experts, markets, or IDs.\n\nQUESTION: ${question}\n\nEVIDENCE:\n${evidenceBlock(segments)}`;
    const evidencePreparationMs = performance.now() - evidenceStart;
    return { ...(await this.generateWithTiming<ModelAnswer>(input, answerSchema)), evidencePreparationMs };
  }

  async analysis(segments: TranscriptSegment[]): Promise<AnalysisItem[]> {
    return (await this.analysisWithTiming(segments)).value;
  }

  async analysisWithTiming(segments: TranscriptSegment[]): Promise<GenerationTiming<AnalysisItem[]>> {
    const evidenceStart = performance.now();
    const input = `Analyse only these three expert interviews. Identify useful common themes, agreements, meaningful disagreements, and market differences. Do not claim a disagreement unless the evidence shows different positions. Use "Based on these interviews" language. Every segment ID must be copied exactly from the evidence. Do not generate quote text or timestamps. Do not generalize beyond these interviews.\n\nEVIDENCE:\n${evidenceBlock(segments)}`;
    const evidencePreparationMs = performance.now() - evidenceStart;
    return { ...(await this.generateWithTiming<AnalysisItem[]>(input, analysisSchema)), evidencePreparationMs };
  }
}

export function validateModelAnswer(answer: ModelAnswer, segments: TranscriptSegment[]): ModelAnswer {
  const validIds = new Set(segments.map((segment) => segment.id));
  const segmentIds = [...new Set(answer.segmentIds ?? [])].filter((id) => validIds.has(id));
  if (segmentIds.length === 0) return { answer: NOT_FOUND, segmentIds: [] };
  return { answer: answer.answer?.trim() || NOT_FOUND, segmentIds };
}

export function validateAnalysis(items: AnalysisItem[], segments: TranscriptSegment[]): AnalysisItem[] {
  const validIds = new Set(segments.map((segment) => segment.id));
  return (items ?? []).map((item) => ({ ...item, segmentIds: [...new Set(item.segmentIds ?? [])].filter((id) => validIds.has(id)) }))
    .filter((item) => ['agreement', 'disagreement', 'difference'].includes(item.type) && item.title && item.synthesis && item.segmentIds.length > 0);
}

export function validateGuideBatch(answer: GuideBatchAnswer, evidenceByDocument: Map<string, TranscriptSegment[]>): GuideBatchAnswer {
  const experts = [...evidenceByDocument.entries()].map(([documentId, evidence]) => {
    const modelResult = answer.experts?.find((item) => item.documentId === documentId);
    const validIds = new Set(evidence.map((segment) => segment.id));
    const segmentIds = [...new Set(modelResult?.segmentIds ?? [])].filter((id) => validIds.has(id));
    return { documentId, answer: segmentIds.length ? (modelResult?.answer?.trim() || NOT_FOUND) : NOT_FOUND, segmentIds };
  });
  return { experts };
}
