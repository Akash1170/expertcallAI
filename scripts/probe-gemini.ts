import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const model = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';

try {
  const interaction = await client.interactions.create({
    model,
    input: 'Return JSON only: {"ok":true}',
    store: false,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    },
  });
  const embedding = await client.models.embedContent({
    model: embeddingModel,
    contents: 'Expert transcript retrieval probe',
    config: { taskType: 'RETRIEVAL_DOCUMENT' },
  });
  console.log(JSON.stringify({ generationSucceeded: Boolean(interaction.output_text), embeddingSucceeded: Boolean(embedding.embeddings?.[0]?.values?.length), embeddingDimensions: embedding.embeddings?.[0]?.values?.length ?? 0 }));
} catch (error) {
  console.error('LIVE_PROBE_FAILED', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
}
