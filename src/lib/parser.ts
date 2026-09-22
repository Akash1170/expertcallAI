import type { TranscriptDocument, TranscriptSegment } from '../types';

const timestampPattern = /^(\d{2}):(\d{2})$/;

export function parseTranscript(document: TranscriptDocument): TranscriptSegment[] {
  const lines = document.rawText.split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const timestampMatch = lines[index].trim().match(timestampPattern);
    if (!timestampMatch) continue;
    const timestamp = lines[index].trim();
    const textLine = lines[index + 1]?.trim() ?? '';
    const separator = textLine.indexOf(':');
    if (separator < 1) continue;
    const speaker = textLine.slice(0, separator).trim();
    const text = textLine.slice(separator + 1).trim();
    const seconds = Number(timestampMatch[1]) * 60 + Number(timestampMatch[2]);
    segments.push({ id: `${document.id}-${segments.length + 1}`, documentId: document.id, expert: document.expert, role: document.role, market: document.market, timestamp, seconds, speaker, text });
  }
  return segments;
}

export function parseAll(documents: TranscriptDocument[]): TranscriptSegment[] {
  return documents.flatMap(parseTranscript);
}
