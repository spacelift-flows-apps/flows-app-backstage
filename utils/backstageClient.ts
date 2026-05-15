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
