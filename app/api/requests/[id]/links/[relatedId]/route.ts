import { getIntelligenceStore, StaleReviewError } from "../../../../../../lib/intelligence-store.ts";
import { isLocalRequest, json } from "../../../../../../lib/http.ts";
import { readSmallJson, JsonInputError } from "../../../../../../lib/read-json.ts";
import { readSupporter } from "../../../../../../lib/supporter.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string; relatedId: string }> }) {
  if (!isLocalRequest(request)) return json({ error: "Update links from this application." }, 403);
  const reviewer = readSupporter(request);
  if (!reviewer) return json({ error: "Allow cookies and reload the board before updating links." }, 400);
  try {
    const body = await readSmallJson(request);
    if (Object.keys(body).some(key => key !== "analysisId") || typeof body.analysisId !== "string" || body.analysisId.length > 100) {
      return json({ error: "Choose a valid link to remove." }, 400);
    }
    const { id, relatedId } = await context.params;
    const intelligence = getIntelligenceStore().dismissLink(id, relatedId, body.analysisId, reviewer);
    if (!intelligence) return json({ error: "This request could not be found." }, 404);
    return json({ intelligence });
  } catch (error) {
    if (error instanceof JsonInputError) return json({ error: error.message }, error.status);
    if (error instanceof StaleReviewError) return json({ error: "This link has changed. Refresh the analysis and try again." }, 409);
    return json({ error: "We couldn't remove this link. Please try again." }, 503);
  }
}
