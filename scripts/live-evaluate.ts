import { transcripts } from '../src/data/transcripts';
import { parseAll } from '../src/lib/parser';
import { NOT_FOUND } from '../src/lib/llm';
import { guideQuestions } from '../src/data/guide';
import type { Citation } from '../src/types';

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:8787';
const segments = parseAll(transcripts);
const byId = new Map(segments.map((segment) => [segment.id, segment]));
const failures: string[] = [];
let checks = 0;

interface AnswerResponse { answer: string; citations: Citation[]; confidence: string; retrievedCount: number; }
interface AnalysisResponse { items: Array<{ type: string; title: string; synthesis: string; segmentIds: string[]; citations: Citation[] }>; retrievedCount: number; }

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function validateCitations(label: string, citations: Citation[], expectedIds?: string[]): void {
  checks += citations.length;
  if (citations.length === 0) failures.push(`${label}: no citations returned`);
  const expected = expectedIds ? new Set(expectedIds) : undefined;
  for (const citation of citations) {
    const segment = byId.get(citation.segmentId);
    if (!segment) { failures.push(`${label}: unknown segment ID ${citation.segmentId}`); continue; }
    if (expected && !expected.has(citation.segmentId)) failures.push(`${label}: citation ID not present in returned analysis item ${citation.segmentId}`);
    if (citation.quote !== segment.text) failures.push(`${label}: quote mismatch for ${citation.segmentId}`);
    if (citation.timestamp !== segment.timestamp) failures.push(`${label}: timestamp mismatch for ${citation.segmentId}`);
    if (citation.expert !== segment.expert) failures.push(`${label}: expert mismatch for ${citation.segmentId}`);
    if (citation.market !== segment.market) failures.push(`${label}: market mismatch for ${citation.segmentId}`);
    if (citation.documentId !== segment.documentId || citation.source !== segment.documentId) failures.push(`${label}: source mismatch for ${citation.segmentId}`);
  }
}

const health = await request<{ semanticEmbeddings: boolean; llm: boolean; segmentCount: number }>('/api/health');
console.log(`Live mode: Gemini embeddings=${health.semanticEmbeddings}, Gemini LLM=${health.llm}, source segments=${health.segmentCount}`);
if (!health.semanticEmbeddings || !health.llm) failures.push('API is not running in live Gemini mode.');
if (health.segmentCount !== segments.length) failures.push(`API segment count ${health.segmentCount} does not match source count ${segments.length}.`);

for (const question of guideQuestions) {
  for (const transcript of transcripts) {
    const result = await request<AnswerResponse>('/api/guide', { question, documentId: transcript.id });
    if (result.answer === NOT_FOUND) failures.push(`Guide/${transcript.market}: returned not-found for ${question}`);
    validateCitations(`Guide/${transcript.market}/${question.slice(0, 24)}`, result.citations);
    if (result.citations.some((citation) => citation.documentId !== transcript.id)) failures.push(`Guide/${transcript.market}: citation crossed document filter.`);
  }
}
console.log(`Guide evaluation: ${guideQuestions.length * transcripts.length} answers checked.`);

const supportedQuestions = [
  'Which expert places the greatest emphasis on training?',
  'What are the major barriers to robotic surgery adoption?',
  'How do purchasing timelines differ?',
  'What does the German expert say about ROI?',
  'Where do the experts disagree?',
];
for (const question of supportedQuestions) {
  const result = await request<AnswerResponse>('/api/ask', { question });
  if (result.answer === NOT_FOUND) failures.push(`Ask supported: returned not-found for ${question}`);
  validateCitations(`Ask/${question}`, result.citations);
}
console.log(`Ask AI supported evaluation: ${supportedQuestions.length} questions checked.`);

const analysis = await request<AnalysisResponse>('/api/analysis', {});
if (analysis.items.length === 0) failures.push('Cross-expert analysis returned no items.');
for (const item of analysis.items) {
  const validIds = item.segmentIds.filter((id) => byId.has(id));
  if (validIds.length !== item.segmentIds.length) failures.push(`Analysis/${item.title}: unknown segment ID.`);
  validateCitations(`Analysis/${item.title}`, item.citations, validIds);
}
console.log(`Cross-expert analysis: ${analysis.items.length} items checked.`);

const unsupportedQuestions = [
  'What reimbursement tax policy does the EU use for robotic surgery?',
  'Which robotic surgery vendor has the highest market share in Europe?',
  'What was the exact return on investment for each hospital?',
  'How many robotic systems will each country purchase next year?',
  'What patient complication rate did each expert report?',
];
for (const question of unsupportedQuestions) {
  const result = await request<AnswerResponse>('/api/ask', { question });
  checks += 1;
  if (result.answer !== NOT_FOUND || result.citations.length !== 0) failures.push(`Ask unsupported: hallucinated evidence for ${question}`);
}
console.log(`Ask AI unsupported evaluation: ${unsupportedQuestions.length} refusals checked.`);

console.log(`Citation checks performed: ${checks}`);
if (failures.length) {
  console.error(`FAILURES (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS - all live Gemini grounding and citation checks passed.');
}
