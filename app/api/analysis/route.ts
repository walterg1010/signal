import { getAIConfig, PROMPT_VERSION } from "../../../lib/analysis-provider.ts";
import { getIntelligenceStore } from "../../../lib/intelligence-store.ts";
import { json } from "../../../lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return json({ ...getAIConfig(), promptVersion: PROMPT_VERSION, byRequest: getIntelligenceStore().overview() });
  } catch {
    return json({ error: "We couldn't load request analysis. Please try again." }, 503);
  }
}
