import { useEffect, useState } from 'react';
import { BookOpen, ChevronRight, CircleHelp, FileText, LayoutDashboard, MessageSquare, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { guideQuestions } from './data/guide';
import { transcripts } from './data/transcripts';
import { parseAll } from './lib/parser';
import type { Citation, TranscriptSegment } from './types';

type View = 'overview' | 'guide' | 'analysis' | 'ask' | 'sources';
const segments = parseAll(transcripts);

interface ApiAnswer { answer: string; citations: Citation[]; confidence: 'high' | 'medium' | 'low' | 'none'; retrievedCount: number; }
interface GuideExpertResult { documentId: string; answer: string; citations: Citation[]; }
interface GuideBatchResult { experts: GuideExpertResult[]; retrievedCounts: Record<string, number>; }
interface AnalysisItem { type: 'agreement' | 'disagreement' | 'difference'; title: string; synthesis: string; citations: Citation[]; }
class ApiError extends Error {
  constructor(public readonly status: number, public readonly retryAfterSeconds?: number) { super('API request failed'); }
}

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new TypeError('Unable to reach the ExpertCall API.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { retryAfterSeconds?: number };
    throw new ApiError(response.status, payload.retryAfterSeconds);
  }
  return response.json() as Promise<T>;
}

function requestError(error: unknown, scope: 'guide' | 'analysis' | 'ask'): string {
  if (error instanceof ApiError && error.status === 429) return `Gemini's free-tier rate limit was reached. Please wait about ${error.retryAfterSeconds ?? 60} seconds and try again.`;
  if (error instanceof TypeError) return 'Unable to reach the ExpertCall API.';
  if (error instanceof ApiError) return `The ${scope === 'ask' ? 'Ask AI' : scope === 'analysis' ? 'cross-expert analysis' : 'guide analysis'} request failed. Please try again.`;
  return 'Unable to reach the ExpertCall API.';
}

function CitationCard({ citation }: { citation: Citation }) {
  return <article className="citation-card">
    <div className="citation-meta"><span>{citation.expert}</span><span>{citation.market}</span><strong>{citation.timestamp}</strong></div>
    <p>“{citation.quote}”</p>
    <small><FileText size={13} /> {citation.source}</small>
  </article>;
}

function EvidenceList({ items }: { items: TranscriptSegment[] }) {
  const citations = items.map((segment) => ({ segmentId: segment.id, documentId: segment.documentId, expert: segment.expert, market: segment.market, timestamp: segment.timestamp, quote: segment.text, source: segment.documentId }));
  return <div className="evidence-list">{citations.map((citation) => <CitationCard key={citation.segmentId} citation={citation} />)}</div>;
}

function App() {
  const [view, setView] = useState<View>('overview');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [askInput, setAskInput] = useState('');
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, GuideBatchResult | null>>({});
  const [askResult, setAskResult] = useState<ApiAnswer | null>(null);
  const [analysisItems, setAnalysisItems] = useState<AnalysisItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (view !== 'guide') return;
    const question = guideQuestions[questionIndex];
    if (questionAnswers[question]) return;
    const controller = new AbortController();
    let active = true;
    const clientStart = performance.now();
    setLoading(true); setError('');
    api<GuideBatchResult>('/api/guide', { question }, controller.signal)
      .then((result) => { if (active) setQuestionAnswers((current) => ({ ...current, [question]: result })); })
      .catch((error) => { if (active && !controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) setError(requestError(error, 'guide')); })
      .finally(() => { if (active) { console.log(`[PERF] guide-client requests=1 wallClock=${(performance.now() - clientStart).toFixed(1)}ms`); setLoading(false); } });
    return () => { active = false; controller.abort(); };
  }, [view, questionIndex]);

  useEffect(() => {
    if (view !== 'analysis' || analysisItems) return;
    const clientStart = performance.now();
    setLoading(true); setError('');
    api<{ items: AnalysisItem[] }>('/api/analysis', {}).then((result) => setAnalysisItems(result.items)).catch((error) => setError(requestError(error, 'analysis'))).finally(() => { console.log(`[PERF] analysis-client requests=1 wallClock=${(performance.now() - clientStart).toFixed(1)}ms`); setLoading(false); });
  }, [view, analysisItems]);

  const question = guideQuestions[questionIndex];
  const batch = questionAnswers[question];
  const questionEvidence = transcripts.map((transcript) => ({ transcript, result: batch?.experts.find((expert) => expert.documentId === transcript.id) ?? null }));

  const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'guide', label: 'Interview guide', icon: BookOpen },
    { id: 'analysis', label: 'Cross-expert analysis', icon: Sparkles },
    { id: 'ask', label: 'Ask across calls', icon: MessageSquare },
    { id: 'sources', label: 'Sources', icon: FileText },
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">EC</span><span>ExpertCall <em>AI</em></span></div>
      <div className="project-label">EUROPEAN ROBOTIC SURGERY</div>
      <nav>{navItems.map(({ id, label, icon: Icon }) => <button className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => setView(id)} key={id}><Icon size={17} /><span>{label}</span>{view === id && <ChevronRight size={15} />}</button>)}</nav>
      <div className="sidebar-foot"><ShieldCheck size={16} /><span>Grounded in 3 source transcripts</span></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><span className="eyebrow">Research workspace / 2026</span><h1>{navItems.find((item) => item.id === view)?.label}</h1></div><div className="source-status"><span className="status-dot" /> Server-grounded index ready</div></header>
      {view === 'overview' && <Overview onNavigate={setView} />}
      {view === 'guide' && <Guide questionIndex={questionIndex} setQuestionIndex={setQuestionIndex} evidence={questionEvidence} />}
      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading-bar">Retrieving timestamped evidence and grounding the response...</div>}
      {view === 'analysis' && <Analysis items={analysisItems} />}
      {view === 'ask' && <Ask input={askInput} setInput={setAskInput} result={askResult} onAsk={() => { setLoading(true); setError(''); api<ApiAnswer>('/api/ask', { question: askInput.trim() }).then(setAskResult).catch((error) => setError(requestError(error, 'ask'))).finally(() => setLoading(false)); }} />}
      {view === 'sources' && <Sources />}
    </main>
  </div>;
}

function Overview({ onNavigate }: { onNavigate: (view: View) => void }) {
  return <div className="page-grid">
    <section className="intro-panel"><div><span className="eyebrow accent">CASE STUDY / MARKET INTELLIGENCE</span><h2>What are experts really saying about robotic surgery adoption?</h2><p>Explore three first-hand calls across France, Germany and the United Kingdom. Every insight stays connected to a timestamped source.</p><button className="primary-button" onClick={() => onNavigate('guide')}>Compare the guide <ChevronRight size={16} /></button></div><div className="intro-index"><span>01</span><div>Source-first<br />analysis</div></div></section>
    <div className="stat-grid"><Stat value="3" label="Expert calls" /><Stat value="3" label="Markets" /><Stat value="6" label="Guide questions" /></div>
    <section className="section-block"><div className="section-heading"><div><span className="eyebrow">PROJECT ORIENTATION</span><h3>Research workspace</h3></div></div><div className="signal-grid"><Signal number="01" title="3 expert interviews" text="France, Germany and the UK" /><Signal number="02" title="6 interview questions" text="Adoption, barriers, economics, training, outlook and purchasing timelines" /><Signal number="03" title="Traceable evidence" text="AI-generated findings link back to exact transcript quotes and timestamps" /></div><p className="muted workspace-note">Use Interview Guide and Cross-Expert Analysis for AI-generated findings.</p></section>
    <section className="method-note"><CircleHelp size={18} /><div><strong>Designed for verifiability</strong><span>Local retrieval finds relevant segments first. Quotes are displayed only after exact text validation against the original source.</span></div><button onClick={() => onNavigate('sources')}>Inspect sources</button></section>
  </div>;
}
function Stat({ value, label }: { value: string; label: string }) { return <div className="stat"><strong>{value}</strong><span>{label}</span></div>; }
function Signal({ number, title, text }: { number: string; title: string; text: string }) { return <article className="signal"><span>{number}</span><h4>{title}</h4><p>{text}</p></article>; }

function ApiEvidence({ citations }: { citations: Citation[] }) { return <div className="evidence-list">{citations.map((citation) => <CitationCard key={citation.segmentId} citation={citation} />)}</div>; }

function Guide({ questionIndex, setQuestionIndex, evidence }: { questionIndex: number; setQuestionIndex: (index: number) => void; evidence: { transcript: typeof transcripts[number]; result: GuideExpertResult | null }[] }) {
  return <div className="page-grid guide-layout"><section className="question-list"><span className="eyebrow">INTERVIEW GUIDE</span><p className="muted">Select a question to compare how each expert answered it.</p>{guideQuestions.map((question, index) => <button className={questionIndex === index ? 'question-row selected' : 'question-row'} key={question} onClick={() => setQuestionIndex(index)}><span>0{index + 1}</span><strong>{question}</strong><ChevronRight size={16} /></button>)}</section><section className="answer-panel"><div className="answer-title"><span className="eyebrow">QUESTION 0{questionIndex + 1}</span><h2>{guideQuestions[questionIndex]}</h2><p>Each answer is generated server-side from retrieved evidence. Quotes and metadata come from the source segments.</p></div><div className="expert-answer-grid">{evidence.map(({ transcript, result }) => <article className="expert-answer" key={transcript.id}><div className="expert-header"><div className="avatar">{transcript.expert.split(' ').map((part) => part[0]).join('').slice(0, 2)}</div><div><strong>{transcript.expert}</strong><span>{transcript.role} · {transcript.market}</span></div></div>{result ? <><p className="answer-summary">{result.answer}</p>{result.citations.length ? <ApiEvidence citations={result.citations} /> : <p className="not-found">Not found in the provided transcript.</p>}</> : <p className="not-found">Retrieving grounded evidence...</p>}</article>)}</div></section></div>;
}

function Analysis({ items }: { items: AnalysisItem[] | null }) {
  return <div className="page-grid"><section className="analysis-hero"><span className="eyebrow accent">CROSS-EXPERT SYNTHESIS</span><h2>What converges, and where the calls diverge</h2><p>AI-generated from retrieved source evidence. Based on these three interviews only; every citation is resolved from the original segment store.</p><div className="analysis-rule"><span>Agreement</span><span>Difference</span><span>3 markets / 3 perspectives</span></div></section><section className="theme-list">{items?.length ? items.map((theme, index) => <article className="theme" key={`${theme.title}-${index}`}><div className={theme.type === 'disagreement' || theme.type === 'difference' ? 'theme-label difference' : 'theme-label'}>{theme.type}</div><div className="theme-copy"><h3>{theme.title}</h3><p>{theme.synthesis}</p><ApiEvidence citations={theme.citations} /></div></article>) : <div className="empty-evidence">Cross-expert evidence will appear after the API retrieves and analyses the source segments.</div>}</section></div>;
}

function Ask({ input, setInput, result, onAsk }: { input: string; setInput: (value: string) => void; result: ApiAnswer | null; onAsk: () => void }) {
  const suggestions = ['Which expert places the greatest emphasis on training?', 'How do purchasing timelines differ?', 'What does the German expert say about ROI?', 'Where do the experts disagree?'];
  return <div className="ask-page"><section className="ask-hero"><span className="eyebrow accent">GROUNDED Q&A</span><h2>Ask the source material.</h2><p>Questions are matched against timestamped transcript segments. The answer stays concise; the evidence stays visible.</p><div className="ask-box"><Search size={19} /><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && onAsk()} placeholder="Ask about adoption, barriers, ROI, training..." /><button onClick={onAsk} disabled={!input.trim()}>Ask AI</button></div><div className="suggestions">{suggestions.map((suggestion) => <button key={suggestion} onClick={() => { setInput(suggestion); }}>{suggestion}</button>)}</div></section>{result && <section className="result-panel"><div className="result-header"><div><span className="eyebrow">ANSWER</span><h3>{result.answer}</h3></div><span className={`confidence ${result.confidence}`}>{result.confidence === 'none' ? 'No evidence' : `${result.confidence} confidence`}</span></div>{result.citations.length ? <><div className="retrieval-note">{result.retrievedCount} relevant segments retrieved · {result.citations.length} citations verified</div><div className="evidence-list">{result.citations.map((citation) => <CitationCard citation={citation} key={citation.segmentId} />)}</div></> : <div className="empty-evidence"><CircleHelp size={19} /> Try a question about the three markets, barriers, economics, training, outlook or purchasing timelines.</div>}</section>}</div>;
}

function Sources() {
  return <div className="page-grid"><section className="sources-intro"><span className="eyebrow accent">SOURCE LIBRARY</span><h2>Every segment keeps its place in the call.</h2><p>Three documents, parsed into {segments.length} timestamped speaker segments. This is the evidence layer used by the guide, synthesis and Q&A views.</p></section><section className="source-docs">{transcripts.map((transcript) => <article className="source-doc" key={transcript.id}><div className="doc-top"><div className="file-icon"><FileText size={19} /></div><div><h3>{transcript.fileName}</h3><p>{transcript.expert} · {transcript.role}</p></div><span>{transcript.market}</span></div><div className="segment-count">{segments.filter((segment) => segment.documentId === transcript.id).length} timestamped segments</div><div className="source-preview">{segments.filter((segment) => segment.documentId === transcript.id).slice(0, 3).map((segment) => <div key={segment.id}><strong>{segment.timestamp}</strong><span>{segment.speaker}</span><p>{segment.text}</p></div>)}</div></article>)}</section></div>;
}

export default App;
