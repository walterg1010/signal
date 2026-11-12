import { isLocalRequest, json } from "../../../../../lib/http.ts";
import { getStore } from "../../../../../lib/store.ts";
import { readSupporter } from "../../../../../lib/supporter.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function setSupport(request: Request, context: Context, supported: boolean) {
  if (!isLocalRequest(request)) {
    return json({ error: "Update support from this application." }, 403);
  }
  const supporterId = readSupporter(request);
  if (!supporterId) {
    // Do not mint identities on writes: concurrent first clicks must not
    // become separate votes. Loading the board establishes the cookie first.
    return json({ error: "Allow cookies for this site and reload the board before adding support." }, 400);
  }

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return json({ error: "This request could not be found." }, 404);
  }
  try {
    const updated = getStore().setSupport(id, supporterId, supported);
    if (!updated) return json({ error: "This request could not be found." }, 404);
    return json({ request: updated });
  } catch (error) {
    console.error("Could not update support:", error);
    return json({ error: "We couldn't update your support. Please try again." }, 503);
  }
}

export function PUT(request: Request, context: Context) {
  return setSupport(request, context, true);
}

export function DELETE(request: Request, context: Context) {
  return setSupport(request, context, false);
}
