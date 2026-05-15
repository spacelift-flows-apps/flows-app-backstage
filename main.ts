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

**1. Allow the Flows endpoint host** (so the catalog can fetch templates):

\`\`\`yaml
backend:
  reading:
    allow:
      - host: {appEndpointHost}
\`\`\`

**2. Add the template catalog location** (Backstage will poll this for new templates):

\`\`\`yaml
catalog:
  locations:
    - type: url
      target: {appEndpointUrl}/templates.yaml
      rules:
        - allow: [Location, Template]
\`\`\`

**3. Configure the proxy** (so templates can trigger workflows):

\`\`\`yaml
proxy:
  endpoints:
    '/flows':
      target: {appEndpointUrl}
      changeOrigin: true
      headers:
        Authorization: 'Bearer <your-auth-token>'
\`\`\`

Replace \`<your-auth-token>\` with the **Auth Token** from the **Signals** tab.

**4. Restart your Backstage backend** to apply the config changes.

After setup, any Backstage Entrypoint block you add will automatically appear in Backstage's "Create" page within a few minutes.`,

  config: {
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

      if (request.path.startsWith("/templates/") && request.path.endsWith(".yaml")) {
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
      const { value: existing } = await kv.app.get(KV_KEYS.AUTH_TOKEN);
      const authToken =
        (existing as string | undefined) || randomBytes(32).toString("hex");

      await kv.app.set({ key: KV_KEYS.AUTH_TOKEN, value: authToken });

      return {
        newStatus: "ready",
        signalUpdates: { authToken },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to sync Backstage app:", message);
      return {
        newStatus: "failed",
        customStatusDescription: `Sync failed: ${message}`,
      };
    }
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

  const blockConfigs = readyBlocks.map((b) => ({
    slug: b.config!.slug as string,
    title: b.config!.title as string,
    description: b.config!.description as string | undefined,
    owner: b.config!.owner as string,
    templateType: b.config!.templateType as string | undefined,
    tags: b.config!.tags as string[] | undefined,
    parameters: b.config!.parameters as
      | TemplateParameter[]
      | undefined,
  }));

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
  const matchedBlock = confirmedBlocks.find(
    (b) => b.config?.slug === slug,
  );

  if (!matchedBlock) {
    await http.respond(request.requestId, {
      statusCode: 404,
      body: { error: `No template found with slug "${slug}"` },
    });
    return;
  }

  const yaml = generateTemplateYAML({
    slug: matchedBlock.config!.slug as string,
    title: matchedBlock.config!.title as string,
    description: matchedBlock.config!.description as string | undefined,
    owner: matchedBlock.config!.owner as string,
    templateType: matchedBlock.config!.templateType as string | undefined,
    tags: matchedBlock.config!.tags as string[] | undefined,
    parameters: matchedBlock.config!.parameters as
      | TemplateParameter[]
      | undefined,
  });

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

  const authHeader = request.headers["Authorization"] || request.headers["authorization"] || "";
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
  const matchedBlock = confirmedBlocks.find(
    (b) => b.config?.slug === slug,
  );

  if (!matchedBlock) {
    await http.respond(request.requestId, {
      statusCode: 404,
      body: { error: `No block found with slug "${slug}"` },
    });
    return;
  }

  await messaging.sendToBlocks({
    body: request.body ?? {},
    blockIds: [matchedBlock.id],
  });

  await http.respond(request.requestId, {
    statusCode: 202,
    body: { status: "accepted", slug },
  });
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
