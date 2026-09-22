export type Market = 'France' | 'Germany' | 'United Kingdom';

export interface TranscriptDocument {
  id: string;
  expert: string;
  role: string;
  market: Market;
  fileName: string;
  rawText: string;
}

export interface TranscriptSegment {
  id: string;
  documentId: string;
  expert: string;
  role: string;
  market: Market;
  timestamp: string;
  seconds: number;
  speaker: string;
  text: string;
}

export interface Citation {
  segmentId: string;
  documentId: string;
  expert: string;
  market: Market;
  timestamp: string;
  quote: string;
  source: string;
}

export interface GroundedAnswer {
  answer: string;
  citations: Citation[];
  confidence: 'high' | 'medium' | 'low' | 'none';
  retrievedCount: number;
}
