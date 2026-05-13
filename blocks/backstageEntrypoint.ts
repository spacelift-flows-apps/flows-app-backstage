import { AppBlock, blocks, events, kv } from "@slflows/sdk/v1";

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(["templates.yaml", "templates", "trigger"]);

export const backstageEntrypoint: AppBlock = {
  name: "Backstage Entrypoint",
  description:
    "Registers a Software Template in Backstage that triggers this workflow when submitted",
  category: "Backstage",
  entrypoint: true,

  config: {
    slug: {
      name: "Slug",
      description:
        "URL-friendly identifier for this template (lowercase letters, numbers, hyphens). Used in the trigger URL and as the template name in Backstage.",
      type: "string",
      required: true,
      fixed: true,
    },
    title: {
      name: "Title",
      description: "Display title shown in Backstage's template catalog",
      type: "string",
      required: true,
      fixed: true,
    },
    description: {
      name: "Description",
      description: "Description shown in Backstage's template catalog",
      type: "string",
      required: false,
      fixed: true,
    },
    // TODO: If we add the Backstage instance URL + token as app config, we could
    // use suggestValues to fetch owners from the Backstage catalog API
    // (e.g. GET /api/catalog/entities?filter=kind=group).
    owner: {
      name: "Owner",
      description:
        "Backstage owner reference (e.g., 'platform-team' or 'group:default/platform-team')",
      type: "string",
      required: true,
      fixed: true,
    },
    templateType: {
      name: "Type",
      description:
        "Backstage template type, used for filtering (e.g., 'service', 'website', 'library')",
      type: "string",
      required: false,
      default: "service",
      fixed: true,
    },
    tags: {
      name: "Tags",
      description: "Tags for filtering in Backstage's template catalog",
      fixed: true,
      type: {
        type: "array",
        items: { type: "string" },
      },
      required: false,
    },
    parameters: {
      name: "Form Parameters",
      description:
        "Form fields shown to users when they launch this template in Backstage. Each parameter becomes a field in the template form and is passed to the workflow on submission.",
      fixed: true,
      required: false,
      type: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Field identifier (used as the key in the submitted data)",
            },
            title: {
              type: "string",
              description: "Display label shown in the form",
            },
            description: {
              type: "string",
              description: "Help text shown below the field",
            },
            type: {
              type: "string",
              enum: ["string", "number", "boolean"],
              description: "Field data type",
            },
            required: {
              type: "boolean",
              description: "Whether the field is required",
            },
            default: {
              type: "string",
              description: "Default value for the field",
            },
            enum: {
              type: "array",
              items: { type: "string" },
              description:
                "List of allowed values (renders as a dropdown for string fields)",
            },
          },
          required: ["name", "title", "type"],
        },
      },
    },
  },

  async onSync(input) {
    const slug = input.block.config.slug as string | undefined;

    if (!slug) {
      return {
        newStatus: "failed",
        customStatusDescription: "Slug is required",
      };
    }

    if (!SLUG_PATTERN.test(slug)) {
      return {
        newStatus: "failed",
        customStatusDescription: `Invalid slug "${slug}". Use only lowercase letters, numbers, and hyphens. Must start and end with a letter or number.`,
      };
    }

    if (RESERVED_SLUGS.has(slug)) {
      return {
        newStatus: "failed",
        customStatusDescription: `Slug "${slug}" is reserved. Choose a different slug.`,
      };
    }

    const { blocks: entrypointBlocks } = await blocks.list({
      typeIds: ["backstageEntrypoint"],
    });

    for (const block of entrypointBlocks) {
      if (block.id === input.block.id) continue;
      if (block.config?.slug === slug) {
        return {
          newStatus: "failed",
          customStatusDescription: `Slug "${slug}" is already used by another Backstage Entrypoint block. Choose a unique slug.`,
        };
      }
    }

    await kv.block.set({ key: "slug", value: slug });
    await kv.app.set({
      key: `confirmed:${input.block.id}`,
      value: true,
    });

    return { newStatus: "ready" };
  },

  async onDrain(input) {
    await kv.app.delete([`confirmed:${input.block.id}`]);

    const allKeys = await kv.block.list({ keyPrefix: "" });
    const keysToDelete = allKeys.pairs.map((pair) => pair.key);
    if (keysToDelete.length > 0) {
      await kv.block.delete(keysToDelete);
    }
    return { newStatus: "drained" };
  },

  async onInternalMessage(input) {
    const slug = input.block.config.slug as string;
    const body = input.message.body as Record<string, unknown>;

    await events.emit({
      slug,
      triggeredAt: new Date().toISOString(),
      parameters: body ?? {},
    });
  },

  outputs: {
    default: {
      name: "Template Triggered",
      description:
        "Emitted when a user submits this Software Template in Backstage",
      default: true,
      type: {
        type: "object",
        properties: {
          slug: { type: "string" },
          triggeredAt: { type: "string" },
          parameters: { type: "object" },
        },
        required: ["slug", "triggeredAt", "parameters"],
      },
    },
  },
};
