import 'dotenv/config';
import { guideQuestions } from '../src/data/guide';
import { transcripts } from '../src/data/transcripts';
import { citationFromSegment } from '../src/lib/citations';
import { DeterministicEmbeddingProvider, GeminiEmbeddingProvider } from '../src/lib/embeddings';
import { GeminiProvider, NOT_FOUND, validateModelAnswer } from '../src/lib/llm';
import { parseAll } from '../src/lib/parser';
import { buildVectorIndex } from '../src/lib/retrieval';

const segments = parseAll(transcripts);
const hasKey = Boolean(process.env.GEMINI_API_KEY);
const embedder = hasKey ? new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY!, process.env.GEMINI_EMBEDDING_MODEL) : new DeterministicEmbeddingProvider();
const llm = hasKey ? new GeminiProvider(process.env.GEMINI_API_KEY!, process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite') : undefined;
const index = await buildVectorIndex(segments, embedder);

console.log(`ExpertCall AI evaluation (${hasKey ? 'Gemini live integration' : 'deterministic no-key retrieval'})`);
console.log('============================================================');
for (const question of guideQuestions) {
  console.log(`\n${question}`);
  for (const transcript of transcripts) {
    const evidence = await index.search(question, embedder, 8, { documentId: transcript.id });
    const modelAnswer = llm ? await llm.answer(question, evidence) : { answer: evidence.length ? 'Evidence retrieved; configure GEMINI_API_KEY for generated answer.' : NOT_FOUND, segmentIds: evidence.slice(0, 2).map((segment) => segment.id) };
    const validated = validateModelAnswer(modelAnswer, evidence);
    const citations = validated.segmentIds.map((id) => evidence.find((segment) => segment.id === id)).map((segment) => segment && citationFromSegment(segment)).filter(Boolean);
    console.log(`${transcript.market}: answer=${validated.answer !== NOT_FOUND} | evidence=${evidence.length} | quote-valid=${citations.length === validated.segmentIds.length} | timestamps=${citations.every((citation) => Boolean(citation?.timestamp))} | source=${citations.every((citation) => Boolean(citation?.source))}`);
  }
}
