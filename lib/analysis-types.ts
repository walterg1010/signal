export type RelatedSuggestion = {
  requestId: string;
  relationship: "duplicate" | "related";
  reason: string;
  sourceEvidence: string;
  targetEvidence: string;
};

export type AnalysisResult = {
  problem: string;
  problemEvidence: string;
  theme: string;
  unknowns: string[];
  suggestions: RelatedSuggestion[];
};

export type AnalysisRun = {
  id: string;
  requestId: string;
  status: "running" | "completed" | "failed";
  model: string;
  promptVersion: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  candidateCount: number;
  error: string | null;
  result: AnalysisResult | null;
};

export type ReviewDecision = {
  relatedRequestId: string;
  decision: "accepted" | "rejected";
  relationship: "duplicate" | "related";
  analysisId: string;
  reviewedAt: string;
};

export type RequestIntelligence = {
  analysis: AnalysisRun | null;
  reviews: ReviewDecision[];
};

export type IntelligenceOverview = {
  available: boolean;
  model: string;
  promptVersion: string;
  byRequest: Record<string, RequestIntelligence>;
};
