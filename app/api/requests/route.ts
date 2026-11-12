import { RequestValidationError, validateRequest } from "../../../lib/requests.ts";
import { getStore } from "../../../lib/store.ts";
import { isLocalRequest, json } from "../../../lib/http.ts";
import { getSupporter } from "../../../lib/supporter.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const supporter = getSupporter(request);
    const response = json({ requests: getStore().list(supporter.id) });
    if (supporter.cookie) response.headers.set("Set-Cookie", supporter.cookie);
    return response;
  } catch (error) {
    console.error("Could not read feature requests:", error);
    return json({ error: "We couldn't load requests. Please try again." }, 503);
  }
}

// Read with a byte limit, including when Content-Length is missing or inaccurate.
async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  if (!isLocalRequest(request)) {
    return json({ error: "Submit requests from this application." }, 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Send the request as JSON." }, 415);
  }

  let input: unknown;
  try {
    const text = await readBody(request);
    if (text === null) return json({ error: "This request is too large." }, 413);
    input = JSON.parse(text);
  } catch {
    return json({ error: "We couldn't read the request. Please try again." }, 400);
  }

  try {
    const valid = validateRequest(input);
    const created = getStore().create(valid);
    return json({ request: created }, 201);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return json({ error: error.message, fieldErrors: error.fieldErrors }, 400);
    }
    console.error("Could not save feature request:", error);
    return json({ error: "We couldn't save your request. Your draft is still here; please try again." }, 503);
  }
}
