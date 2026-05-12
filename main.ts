import {
  defineApp,
  kv,
  http,
  blocks as blocksApi,
  messaging,
} from "@slflows/sdk/v1";
import { randomBytes, timingSafeEqual } from "crypto";
import { blocks } from "./blocks/index";
import { generateMultiDocumentYaml } from "./utils/templateYaml";

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
        - allow: [Template]
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

  config: {},

  http: {
    onRequest: async ({ request }) => {
      switch (request.path) {
        case "/templates.yaml": {
          const { blocks: entrypointBlocks } = await blocksApi.list({
            typeIds: ["backstageEntrypoint"],
          });

          const readyBlocks = entrypointBlocks.filter(
            (b) => b.config?.slug && b.config?.title && b.config?.owner,
          );

          if (readyBlocks.length === 0) {
            await http.respond(request.requestId, {
              statusCode: 200,
              headers: { "Content-Type": "text/yaml" },
              body: "# No Backstage Entrypoint blocks configured yet\n",
            });
            return;
          }

          const yaml = generateMultiDocumentYaml(
            readyBlocks.map((b) => ({
              slug: b.config!.slug as string,
              title: b.config!.title as string,
              description: b.config!.description as string | undefined,
              owner: b.config!.owner as string,
              templateType: b.config!.templateType as string | undefined,
              tags: b.config!.tags as string[] | undefined,
            })),
          );

          await http.respond(request.requestId, {
            statusCode: 200,
            headers: { "Content-Type": "text/yaml" },
            body: yaml,
          });
          return;
        }
      }

      if (request.path.startsWith("/trigger/")) {
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

        const { blocks: entrypointBlocks } = await blocksApi.list({
          typeIds: ["backstageEntrypoint"],
        });

        const matchedBlock = entrypointBlocks.find(
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
        return;
      }

      await http.respond(request.requestId, {
        statusCode: 404,
        body: { error: "Not found" },
      });
    },
  },

  async onSync() {
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
