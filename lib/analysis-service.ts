import { getStore } from "./store.ts";
import { getIntelligenceStore } from "./intelligence-store.ts";
import {
  analyzeRequest, getAIConfig, PROMPT_VERSION, AIProviderError, validateAnalysisResult,
} from "./analysis-provider.ts";
import type { AnalysisResult, RequestIntelligence } from "./analysis-types.ts";

export class AnalysisServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AnalysisServiceError";
    this.status = status;
  }
}

type AnalysisInput = { id: string; title: string; description: string };
type Dependencies = {
  config?: () => { available: boolean; model: string };
  analyze?: (source: AnalysisInput, candidates: AnalysisInput[]) => Promise<AnalysisResult>;
};

export async function runAnalysis(
  requestId: string,
  force = false,
  dependencies: Dependencies = {},
): Promise<{ status: 200 | 202; intelligence: RequestIntelligence }> {
  const requests = getStore().list();
  const source = requests.find(item => item.id === requestId);
  if (!source) throw new AnalysisServiceError("This request could not be found.", 404);
  const config = (dependencies.config ?? getAIConfig)();
  if (!config.available) {
    throw new AnalysisServiceError("AI analysis is not connected yet. Your request is saved.", 503);
  }

  // A bounded comparison set keeps the first version predictable in cost and
  // latency. These are candidates, not matches; the model must decide whether
  // any actually share the customer's problem and support that with quotes.
  const sourceText = { id: source.id, title: source.title, description: source.description };
  const candidates = requests.filter(item => item.id !== requestId).slice(0, 20)
    .map(item => ({ id: item.id, title: item.title, description: item.description.slice(0, 1500) }));
  const store = getIntelligenceStore();
  const claim = store.begin(requestId, {
    model: config.model, promptVersion: PROMPT_VERSION, candidateCount: candidates.length, force,
  });
  if (claim.kind === "busy") {
    throw new AnalysisServiceError("Analysis is at its local usage limit. Please try again later.", 429);
  }
  if (claim.kind === "cached" || claim.kind === "running") {
    return { status: claim.kind === "running" ? 202 : 200, intelligence: store.get(requestId) };
  }
  const run = claim.analysis;
  if (!run) throw new AnalysisServiceError("Analysis could not be started. Please try again.", 503);
  const started = Date.now();
  try {
    const output = await (dependencies.analyze ?? analyzeRequest)(sourceText, candidates);
    const result = validateAnalysisResult(output, sourceText, candidates);
    const stored = store.finish(run.id, result, Date.now() - started);
    if (!stored) {
      throw new AnalysisServiceError("This analysis expired. Refresh the board and try again.", 409);
    }
    return { status: 200, intelligence: store.get(requestId) };
  } catch (error) {
    const message = error instanceof AIProviderError || error instanceof AnalysisServiceError
      ? error.message : "We couldn't complete the analysis. Your request is saved; please try again.";
    store.fail(run.id, message, Date.now() - started);
    if (error instanceof AnalysisServiceError) throw error;
    throw new AnalysisServiceError(message, 503);
  }
}
