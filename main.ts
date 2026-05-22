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
  verifyBackstageConnection,
  refreshBackstageCatalog,
} from "./utils/backstageClient.ts";
import { IDENTIFIER_PATTERN } from "./utils/validation.ts";

const KV_KEYS = {
  AUTH_TOKEN: "authToken",
  URL_SECRET: "urlSecret",
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
    catalogUrl: {
      name: "Catalog URL",
      description:
        "URL for the Backstage catalog location. Use this as the target in your catalog.locations config.",
      sensitivity: "hide_by_default",
    },
  },

  installationInstructions: `## Prerequisites

If not set up already, these are common Backstage features this app depends on.

### External access token

Add to \`app-config.yaml\`:

\`\`\`yaml
backend:
  auth:
    externalAccess:
      - type: static
        options:
          token: \${BACKSTAGE_API_TOKEN}
          subject: flows-service
\`\`\`

Then, set a token as an environment variable before starting Backstage.

\`\`\`sh
export BACKSTAGE_API_TOKEN=<any-secret-string-you-choose>
\`\`\`

Use this token as the **Backstage API Token** in the app configuration.

### HTTP scaffolder action

Add this plugin so templates can make requests to Flows:

\`\`\`sh
yarn --cwd packages/backend add @roadiehq/scaffolder-backend-module-http-request
\`\`\`

Then, register it in \`packages/backend/src/index.ts\`:

\`\`\`ts
backend.add(import('@roadiehq/scaffolder-backend-module-http-request'));
\`\`\`

### Allow the Flows endpoint host

Add to \`app-config.yaml\`:

\`\`\`yaml
backend:
  reading:
    allow:
      - host: {appEndpointHost}
\`\`\`

## Backstage Configuration

After confirming the app installation, copy the values from the **Signals** tab and set them as environment variables before starting Backstage:

\`\`\`sh
export FLOWS_CATALOG_URL="<Catalog URL from Signals tab>"
export FLOWS_AUTH_HEADER="Bearer <Auth Token from Signals tab>"
\`\`\`

### 1. Add the template catalog location

\`\`\`yaml
catalog:
  locations:
    - type: url
      target: \${FLOWS_CATALOG_URL}
      rules:
        - allow: [Location, Template]
\`\`\`

### 2. Configure the proxy

\`\`\`yaml
proxy:
  endpoints:
    '/flows':
      target: {appEndpointUrl}
      changeOrigin: true
      headers:
        Authorization: \${FLOWS_AUTH_HEADER}
\`\`\`

### 3. Restart your Backstage backend

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
        "Grouping identifier for templates in the Backstage catalog, used to isolate across teams or environments (e.g., platform-team). Lowercase, alphanumeric, and hyphens only.",
      type: "string",
      required: false,
    },
  },

  http: {
    onRequest: async ({ request, app }) => {
      const { value: urlSecret } = await kv.app.get(KV_KEYS.URL_SECRET);

      if (urlSecret && request.path.startsWith(`/${urlSecret}/`)) {
        const subPath = request.path.slice(String(urlSecret).length + 1);

        if (subPath === "/templates.yaml") {
          return handleTemplatesIndex(request, app, urlSecret as string);
        }

        if (subPath.startsWith("/templates/") && subPath.endsWith(".yaml")) {
          const slug = subPath.slice("/templates/".length, -".yaml".length);
          return handleTemplateYAML(request, slug);
        }
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
    if (namespace && !IDENTIFIER_PATTERN.test(namespace)) {
      return {
        newStatus: "failed",
        customStatusDescription:
          "Invalid namespace. Use only lowercase letters, numbers, and hyphens. Must start and end with a letter or number.",
      };
    }

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

    const { value: existingAuth } = await kv.app.get(KV_KEYS.AUTH_TOKEN);
    const authToken =
      (existingAuth as string | undefined) || randomBytes(32).toString("hex");
    await kv.app.set({ key: KV_KEYS.AUTH_TOKEN, value: authToken });

    const { value: existingUrlToken } = await kv.app.get(KV_KEYS.URL_SECRET);
    const urlSecret =
      (existingUrlToken as string | undefined) ||
      randomBytes(32).toString("base64url");
    await kv.app.set({ key: KV_KEYS.URL_SECRET, value: urlSecret });

    await refreshBackstageCatalog(input.app.config, input.app.http.url);

    const catalogUrl = `${input.app.http.url}/${urlSecret}/templates.yaml`;

    return {
      newStatus: "ready",
      signalUpdates: { authToken, catalogUrl },
    };
  },

  async onDrain(input) {
    // Best-effort: if Backstage is unreachable, it will pick up the
    // updated location on its next poll cycle once it's back.
    try {
      await refreshBackstageCatalog(input.app.config, input.app.http.url);
    } catch (error) {
      console.log(`Catalog refresh failed during drain: ${error}`);
    }
    return { newStatus: "drained" };
  },

  blocks,
});

async function handleTemplatesIndex(
  request: HTTPRequest,
  app: { http: AppHTTPEndpoint; config: Record<string, unknown> },
  urlSecret: string,
) {
  const readyBlocks = await getReadyBlocks();

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
  const yaml = generateLocationYAML(
    app.http.url,
    blockConfigs,
    namespace,
    urlSecret,
  );

  await http.respond(request.requestId, {
    statusCode: 200,
    headers: { "Content-Type": "text/yaml" },
    body: yaml,
  });
}

async function handleTemplateYAML(request: HTTPRequest, slug: string) {
  const readyBlocks = await getReadyBlocks();
  const matchedBlock = readyBlocks.find((b) => b.config?.slug === slug);

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

  const readyBlocks = await getReadyBlocks();
  const matchedBlock = readyBlocks.find((b) => b.config?.slug === slug);

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

async function getReadyBlocks() {
  const { blocks: readyBlocks } = await blocksApi.list({
    typeIds: ["backstageEntrypoint"],
    statuses: ["ready"],
  });

  return readyBlocks;
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
