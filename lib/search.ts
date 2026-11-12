type SearchableRequest = {
  title: string;
  description: string;
};

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function filterRequests<T extends SearchableRequest>(
  requests: readonly T[],
  query: string,
): T[] {
  const term = normalizeSearchText(query).trim();
  if (!term) return [...requests];

  return requests.filter((request) =>
    normalizeSearchText(request.title).includes(term)
    || normalizeSearchText(request.description).includes(term),
  );
}
