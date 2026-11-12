import { getIntelligenceStore, StaleReviewError } from "../../../../../lib/intelligence-store.ts";
import { isLocalRequest, json } from "../../../../../lib/http.ts";
import { readSmallJson, JsonInputError } from "../../../../../lib/read-json.ts";
import { readSupporter } from "../../../../../lib/supporter.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isLocalRequest(request)) return json({ error: "Review suggestions from this application." }, 403);
  const reviewer = readSupporter(request);
  if (!reviewer) return json({ error: "Allow cookies and reload the board before reviewing suggestions." }, 400);
  try {
    const body = await readSmallJson(request);
    if (Object.keys(body).some(key => !["analysisId", "relatedRequestId", "decision"].includes(key))
        || typeof body.analysisId !== "string" || body.analysisId.length > 100
        || typeof body.relatedRequestId !== "string" || body.relatedRequestId.length > 100
        || (body.decision !== "accepted" && body.decision !== "rejected")) {
      return json({ error: "Choose a valid suggestion and review decision." }, 400);
    }
    const { id } = await context.params;
    const intelligence = getIntelligenceStore().review(id, {
      analysisId: body.analysisId,
      relatedRequestId: body.relatedRequestId,
      decision: body.decision,
    }, reviewer);
    if (!intelligence) return json({ error: "This request could not be found." }, 404);
    return json({ intelligence });
  } catch (error) {
    if (error instanceof JsonInputError) return json({ error: error.message }, error.status);
    if (error instanceof StaleReviewError) {
      return json({ error: "This suggestion has changed. Refresh the analysis before reviewing it." }, 409);
    }
    return json({ error: "We couldn't save your review. Please try again." }, 503);
  }
}
