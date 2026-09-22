import { GoogleGenAI } from '@google/genai';
import type { EmbeddingProvider } from './retrieval';

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly client: GoogleGenAI;
  readonly modelName: string;

  constructor(apiKey: string, modelName = 'gemini-embedding-001') {
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
  }

  async embed(text: string, taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' = 'RETRIEVAL_DOCUMENT'): Promise<number[]> {
    const result = await this.client.models.embedContent({
      model: this.modelName,
      contents: text,
      config: { taskType },
    });
    const values = result.embeddings?.[0]?.values;
    if (!values?.length) throw new Error(`Embedding model ${this.modelName} returned no vector.`);
    return values;
  }
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly isDeterministicFallback = true;

  constructor(private readonly dimensions = 96) {}

  async embed(text: string): Promise<number[]> {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const word of words) {
      let hash = 2166136261;
      for (let index = 0; index < word.length; index += 1) hash = Math.imul(hash ^ word.charCodeAt(index), 16777619);
      vector[Math.abs(hash) % this.dimensions] += 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
    return magnitude ? vector.map((value) => value / magnitude) : vector;
  }
}
