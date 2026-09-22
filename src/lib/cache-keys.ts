export const PIPELINE_VERSION = 'grounded-rag-v2';

export function normalizedCacheText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function answerCacheKey(question: string, filter?: { documentId?: string; expert?: string; market?: string }): string {
  return [PIPELINE_VERSION, 'answer', normalizedCacheText(question), filter?.documentId ?? '', filter?.expert ?? '', filter?.market ?? ''].join('|');
}

export function guideBatchCacheKey(question: string): string {
  return [PIPELINE_VERSION, 'guide-batch', normalizedCacheText(question)].join('|');
}