import {
  defineApp,
  kv,
  http,
  blocks as blocksApi,
  messaging,
  type HTTPRequest,
  type AppHTTPEndpoint,
} from "@slflows/sdk/v1";
import { randomBytes, timingSafeEqual } from "crypto";
import { blocks } from "./blocks/index";
import {
  generateLocationYAML,
  generateTemplateYAML,
  type TemplateParameter,
} from "./utils/templateYAML.ts";
import {
  strippedBackstageURL,
  verifyBackstageConnection,
  refreshBackstageCatalog,
} from "./utils/backstageClient.ts";

const KV_KEYS = {
  AUTH_TOKEN: "authToken",
};

export const app = defineApp({
  name: "Backstage Integration",

  signals: {
    authToken: {
      name: "Auth Token",
      description:
        "Auto-generated token for authenticating requests from Backstage. Use this value in your Backstage proxy configuration.",
      sensitivity: "hide_by_default",
    },
  },

  installationInstructions: `Integrates with Backstage Software Templates. Each Backstage Entrypoint block you add registers as a Software Template in Backstage.

## Backstage Configuration

Add the following to your Backstage \`app-config.yaml\`:

**1. Configure external access** (so Flows can communicate with the Backstage API):

Set a token as an environment variable before starting Backstage:

\`\`\`
export BACKSTAGE_API_TOKEN=<any-secret-string-you-choose>
\`\`\`

Then add to \`app-config.yaml\`:

\`\`\`yaml
backend:
  auth:
    externalAccess:
      - type: static
        options:
          token: \${BACKSTAGE_API_TOKEN}
          subject: flows-service
\`\`\`

Use this token as the **Backstage API Token** in the app configuration.

**2. Allow the Flows endpoint host** (so the catalog can fetch templates):

\`\`\`yaml
backend:
  reading:
    allow:
      - host: {appEndpointHost}
\`\`\`

**3. Add the template catalog location** (Backstage will poll this for new templates):

\`\`\`yaml
catalog:
  locations:
    - type: url
      target: {appEndpointUrl}/templates.yaml
      rules:
        - allow: [Location, Template]
\`\`\`

**4. Configure the proxy** (so templates can trigger workflows):

Set the Flows auth token as environment variables before starting Backstage:

\`\`\`
export FLOWS_AUTH_HEADER="Bearer <auth-token-from-signals-tab>"
\`\`\`

\`\`\`yaml
proxy:
  endpoints:
    '/flows':
      target: {appEndpointUrl}
      changeOrigin: true
      headers:
        Authorization: \${FLOWS_AUTH_HEADER}
\`\`\`

**5. Restart your Backstage backend** to apply the config changes.

After setup, any Backstage Entrypoint block you add will appear in Backstage's "Create" page shortly after being confirmed.`,

  config: {
    backstageUrl: {
      name: "Backstage URL",
      description:
        "Base URL of the Backstage backend (e.g., https://backstage.example.com:7007)",
      type: "string",
      required: true,
    },
    backstageApiToken: {
      name: "Backstage API Token",
      description:
        "Static API token for authenticating with Backstage (configured in backend.auth.externalAccess)",
      type: "string",
      required: true,
      sensitive: true,
    },
    namespace: {
      name: "Namespace",
      description:
        "Grouping identifier for templates in the Backstage catalog, used to isolate across teams or environments (e.g., platform-team). Lowercase, alphanumeric, hyphens, and underscores only.",
      type: "string",
      required: false,
    },
  },

  http: {
    onRequest: async ({ request, app }) => {
      if (request.path === "/templates.yaml") {
        return handleTemplatesIndex(request, app);
      }

      if (
        request.path.startsWith("/templates/") &&
        request.path.endsWith(".yaml")
      ) {
        return handleTemplateYAML(request);
      }

      if (request.path.startsWith("/trigger/")) {
        return handleTrigger(request);
      }

      await http.respond(request.requestId, {
        statusCode: 404,
        body: { error: "Not found" },
      });
    },
  },

  async onSync(input) {
    const namespace = input.app.config.namespace as string | undefined;
    if (namespace && !/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(namespace)) {
      return {
        newStatus: "failed",
        customStatusDescription:
          "Invalid namespace. Use only lowercase letters, numbers, hyphens, and underscores. Must start and end with a letter or number.",
      };
    }

    try {
      const response = await verifyBackstageConnection(input.app.config);

      if (response.status === 401) {
        return {
          newStatus: "failed",
          customStatusDescription:
            "Backstage API token is invalid. Verify backend.auth.externalAccess is configured and the token matches.",
        };
      }

      if (!response.ok) {
        return {
          newStatus: "failed",
          customStatusDescription: `Backstage returned HTTP ${response.status}. Verify the Backstage URL is correct and the backend is running.`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backstageUrl = strippedBackstageURL(input.app.config);
      return {
        newStatus: "failed",
        customStatusDescription: `Cannot reach Backstage at ${backstageUrl}: ${message}`,
      };
    }

    try {
      const { value: existing } = await kv.app.get(KV_KEYS.AUTH_TOKEN);
      const authToken =
        (existing as string | undefined) || randomBytes(32).toString("hex");

      await kv.app.set({ key: KV_KEYS.AUTH_TOKEN, value: authToken });

      refreshBackstageCatalog(input.app.config, input.app.http.url);

      return {
        newStatus: "ready",
        signalUpdates: { authToken },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        newStatus: "failed",
        customStatusDescription: `Sync failed: ${message}`,
      };
    }
  },

  async onDrain(input) {
    // Best-effort refresh — the endpoint may already be torn down.
    // Safer to remove the catalog location from Backstage config first.
    await refreshBackstageCatalog(input.app.config, input.app.http.url);
    return { newStatus: "drained" };
  },

  blocks,
});

async function handleTemplatesIndex(
  request: HTTPRequest,
  app: { http: AppHTTPEndpoint; config: Record<string, unknown> },
) {
  const readyBlocks = await getConfirmedBlocks();

  if (readyBlocks.length === 0) {
    await http.respond(request.requestId, {
      statusCode: 200,
      headers: { "Content-Type": "text/yaml" },
      body: "# No Backstage Entrypoint blocks configured yet\n",
    });
    return;
  }

  const blockConfigs = readyBlocks.map(toBlockConfig);

  const namespace = app.config.namespace as string | undefined;
  const yaml = generateLocationYAML(app.http.url, blockConfigs, namespace);

  await http.respond(request.requestId, {
    statusCode: 200,
    headers: { "Content-Type": "text/yaml" },
    body: yaml,
  });
}

async function handleTemplateYAML(request: HTTPRequest) {
  const slug = request.path.slice("/templates/".length, -".yaml".length);
  const confirmedBlocks = await getConfirmedBlocks();
  const matchedBlock = confirmedBlocks.find((b) => b.config?.slug === slug);

  if (!matchedBlock) {
    await http.respond(request.requestId, {
      statusCode: 404,
      body: { error: `No template found with slug "${slug}"` },
    });
    return;
  }

  const yaml = generateTemplateYAML(toBlockConfig(matchedBlock));

  await http.respond(request.requestId, {
    statusCode: 200,
    headers: { "Content-Type": "text/yaml" },
    body: yaml,
  });
}

async function handleTrigger(request: HTTPRequest) {
  if (request.method !== "POST") {
    await http.respond(request.requestId, {
      statusCode: 405,
      body: { error: "Method not allowed" },
    });
    return;
  }

  const authHeader =
    request.headers["Authorization"] || request.headers["authorization"] || "";
  const token = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7)
    : "";

  const { value: storedToken } = await kv.app.get(KV_KEYS.AUTH_TOKEN);
  if (
    !token ||
    !storedToken ||
    token.length !== storedToken.length ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(storedToken))
  ) {
    await http.respond(request.requestId, {
      statusCode: 401,
      body: { error: "Unauthorized" },
    });
    return;
  }

  const slug = request.path.slice("/trigger/".length);
  if (!slug) {
    await http.respond(request.requestId, {
      statusCode: 400,
      body: { error: "Missing slug" },
    });
    return;
  }

  const confirmedBlocks = await getConfirmedBlocks();
  const matchedBlock = confirmedBlocks.find((b) => b.config?.slug === slug);

  if (!matchedBlock) {
    await http.respond(request.requestId, {
      statusCode: 404,
      body: { error: `No block found with slug "${slug}"` },
    });
    return;
  }

  const parameters = (matchedBlock.config?.parameters ??
    []) as TemplateParameter[];
  const errors = validateBody(request.body ?? {}, parameters);
  if (errors.length > 0) {
    await http.respond(request.requestId, {
      statusCode: 400,
      body: { error: "Validation failed", details: errors },
    });
    return;
  }

  await messaging.sendToBlocks({
    body: request.body ?? {},
    blockIds: [matchedBlock.id],
  });

  const successMessage =
    (matchedBlock.config?.successMessage as string | undefined) ||
    "Workflow triggered successfully.";

  await http.respond(request.requestId, {
    statusCode: 202,
    headers: { "Content-Type": "text/plain" },
    body: successMessage,
  });
}

function validateBody(
  body: Record<string, unknown>,
  parameters: TemplateParameter[],
): string[] {
  const errors: string[] = [];

  for (const param of parameters) {
    const value = body[param.name];

    if (value === undefined || value === null) {
      if (param.required) {
        errors.push(`Missing required field "${param.name}"`);
      }
      continue;
    }

    if (typeof value !== param.type) {
      errors.push(
        `Field "${param.name}" must be ${param.type}, got ${typeof value}`,
      );
      continue;
    }

    if (
      param.enum &&
      param.enum.length > 0 &&
      !param.enum.includes(String(value))
    ) {
      errors.push(
        `Field "${param.name}" must be one of: ${param.enum.join(", ")}`,
      );
    }
  }

  return errors;
}

async function getConfirmedBlocks() {
  const { blocks: allBlocks } = await blocksApi.list({
    typeIds: ["backstageEntrypoint"],
  });

  const confirmed = await kv.app.list({ keyPrefix: "confirmed:" });
  const confirmedIds = new Set(
    confirmed.pairs.map((p) => p.key.slice("confirmed:".length)),
  );

  return allBlocks.filter((b) => confirmedIds.has(b.id));
}

function toBlockConfig(b: { config?: Record<string, unknown> | null }) {
  return {
    slug: b.config!.slug as string,
    title: b.config!.title as string,
    description: b.config!.description as string | undefined,
    owner: b.config!.owner as string,
    templateType: b.config!.templateType as string | undefined,
    tags: b.config!.tags as string[] | undefined,
    parameters: b.config!.parameters as TemplateParameter[] | undefined,
  };
}
