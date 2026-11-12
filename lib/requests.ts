export type FeatureRequest = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  supportCount: number;
  supportedByViewer: boolean;
};

export type RequestInput = Pick<FeatureRequest, "title" | "description">;
export type FieldErrors = Partial<Record<keyof RequestInput, string>>;

export class RequestValidationError extends Error {
  fieldErrors: FieldErrors;

  constructor(fieldErrors: FieldErrors) {
    super("Check the highlighted fields and try again.");
    this.name = "RequestValidationError";
    this.fieldErrors = fieldErrors;
  }
}

export function validateRequest(input: unknown): RequestInput {
  const fields = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const fieldErrors: FieldErrors = {};
  const title = typeof fields.title === "string" ? fields.title.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";

  if (!title) fieldErrors.title = "Give your request a title.";
  else if (title.length > 120) fieldErrors.title = "Keep the title to 120 characters or fewer.";
  else if (title.includes("\0")) fieldErrors.title = "Remove the unsupported character from the title.";

  if (!description) fieldErrors.description = "Describe the problem you want to solve.";
  else if (description.length > 4000) fieldErrors.description = "Keep the description to 4,000 characters or fewer.";
  else if (description.includes("\0")) fieldErrors.description = "Remove the unsupported character from the description.";

  if (Object.keys(fieldErrors).length) throw new RequestValidationError(fieldErrors);
  return { title, description };
}
