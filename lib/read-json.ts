export class JsonInputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "JsonInputError";
    this.status = status;
  }
}

export async function readSmallJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new JsonInputError("Send the request as JSON.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new JsonInputError("The request body is missing.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new JsonInputError("This request is too large.", 413);
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JsonInputError("Send a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof JsonInputError) throw error;
    throw new JsonInputError("We couldn't read the request.");
  } finally {
    reader.releaseLock();
  }
}
