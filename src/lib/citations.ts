import type { Citation, TranscriptSegment } from '../types';

export function verifyQuote(quote: string, segment: TranscriptSegment): boolean {
  return quote.trim().length > 0 && segment.text.includes(quote.trim());
}

export function citationFromSegment(segment: TranscriptSegment, quote = segment.text): Citation | null {
  if (!verifyQuote(quote, segment)) return null;
  return { segmentId: segment.id, documentId: segment.documentId, expert: segment.expert, market: segment.market, timestamp: segment.timestamp, quote: quote.trim(), source: segment.documentId };
}
