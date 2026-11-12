import { runAnalysis, AnalysisServiceError } from "../../../../../lib/analysis-service.ts";
import { isLocalRequest, json } from "../../../../../lib/http.ts";
import { readSmallJson, JsonInputError } from "../../../../../lib/read-json.ts";
import { readSupporter } from "../../../../../lib/supporter.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!isLocalRequest(request)) return json({ error: "Run analysis from this application." }, 403);
  if (!readSupporter(request)) return json({ error: "Allow cookies and reload the board before running analysis." }, 400);
  try {
    const body = await readSmallJson(request);
    if (Object.keys(body).some(key => key !== "force") || (body.force !== undefined && typeof body.force !== "boolean")) {
      return json({ error: "The force option must be a boolean." }, 400);
    }
    const { id } = await context.params;
    const outcome = await runAnalysis(id, body.force === true);
    return json({ intelligence: outcome.intelligence }, outcome.status);
  } catch (error) {
    if (error instanceof JsonInputError || error instanceof AnalysisServiceError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "We couldn't start analysis. Your request is saved; please try again." }, 503);
  }
}
