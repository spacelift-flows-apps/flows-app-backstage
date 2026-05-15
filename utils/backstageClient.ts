export function strippedBackstageURL(config: Record<string, unknown>): string {
  return (config.backstageUrl as string).replace(/\/$/, "");
}

export function endpointSlug(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

function locationEntityRef(
  config: Record<string, unknown>,
  endpointUrl: string,
): string {
  const namespace = (config.namespace as string | undefined) || "default";
  return `location:${namespace}/flows-templates-${endpointSlug(endpointUrl)}`;
}

export async function verifyBackstageConnection(
  config: Record<string, unknown>,
): Promise<Response> {
  const backstageUrl = strippedBackstageURL(config);
  return fetch(
    `${backstageUrl}/api/catalog/entities?filter=kind=template&limit=1`,
    { headers: catalogHeaders(config) },
  );
}

export async function refreshBackstageCatalog(
  config: Record<string, unknown>,
  endpointUrl: string,
): Promise<Response> {
  const backstageUrl = strippedBackstageURL(config);
  const backstageApiToken = config.backstageApiToken as string;
  const entityRef = locationEntityRef(config, endpointUrl);

  return fetch(`${backstageUrl}/api/catalog/refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${backstageApiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ entityRef }),
  });
}

// Simple TTL cache for catalog queries to avoid hammering the API during
// suggestValues calls as the user types.
const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

async function cachedFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data as T;
  }
  const data = await fn();
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

interface CatalogEntity {
  kind: string;
  metadata: { name: string; namespace?: string; tags?: string[] };
  spec?: { type?: string };
}

function catalogHeaders(config: Record<string, unknown>) {
  return { Authorization: `Bearer ${config.backstageApiToken as string}` };
}

const OWNERS_LIMIT = 200;

export async function fetchOwners(
  config: Record<string, unknown>,
): Promise<{ values: { label: string; value: string }[]; capped: boolean }> {
  const backstageUrl = strippedBackstageURL(config);

  const entities = await cachedFetch<CatalogEntity[]>("owners", async () => {
    const response = await fetch(
      `${backstageUrl}/api/catalog/entities?filter=kind=group&filter=kind=user&fields=kind,metadata.name,metadata.namespace&limit=${OWNERS_LIMIT}`,
      { headers: catalogHeaders(config) },
    );
    if (!response.ok) return [];
    return response.json();
  });

  const values = entities.map((e) => {
    const ref =
      `${e.kind}:${e.metadata.namespace || "default"}/${e.metadata.name}`.toLowerCase();
    return { label: `${e.metadata.name} (${ref})`, value: ref };
  });

  return { values, capped: entities.length >= OWNERS_LIMIT };
}

export async function fetchTemplateTypes(
  config: Record<string, unknown>,
): Promise<{ label: string; value: string }[]> {
  const backstageUrl = strippedBackstageURL(config);

  const entities = await cachedFetch<CatalogEntity[]>("types", async () => {
    const response = await fetch(
      `${backstageUrl}/api/catalog/entities?filter=kind=template&fields=spec.type`,
      { headers: catalogHeaders(config) },
    );
    if (!response.ok) return [];
    return response.json();
  });

  const types = new Set<string>();
  for (const e of entities) {
    if (e.spec?.type) {
      types.add(e.spec.type);
    }
  }

  return [...types].sort().map((t) => ({ label: t, value: t }));
}
