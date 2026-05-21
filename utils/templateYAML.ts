import { stringify } from "yaml";
import { endpointSlug } from "./backstageClient.ts";

export interface TemplateParameter {
  name: string;
  title: string;
  description?: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string;
  enum?: string[];
}

interface BlockConfig {
  slug: string;
  title: string;
  description?: string;
  owner: string;
  templateType?: string;
  tags?: string[];
  parameters?: TemplateParameter[];
}

export function generateTemplateYAML(blockConfig: BlockConfig): string {
  const { slug, title, description, owner, templateType, tags, parameters } =
    blockConfig;

  const metadata: Record<string, unknown> = {
    name: slug,
    title,
  };
  if (description) {
    // Backstage shows the description as a single line in the catalog card,
    // so collapse any newlines from the config into spaces.
    metadata.description = description.replace(/\s*\n\s*/g, " ").trim();
  }
  if (tags && tags.length > 0) {
    metadata.tags = tags;
  }

  const parametersSpec = buildParametersSpec(parameters);
  const body = buildBody(parameters);

  // Built as a literal string so the Backstage ${{ }} expressions and
  // Jinja-style {%- if %} blocks are preserved verbatim in the YAML output.
  const outputContent = [
    `{%- if steps['trigger-flow'].output.code | int >= 400 %}`,
    `**Request failed (status \${{ steps['trigger-flow'].output.code }})**`,
    ``,
    `Please contact the Platform team for assistance.`,
    `{%- else %}`,
    `\${{ steps['trigger-flow'].output.body.message }}`,
    `{%- endif %}`,
  ].join("\n");

  const doc = {
    apiVersion: "scaffolder.backstage.io/v1beta3",
    kind: "Template",
    metadata,
    spec: {
      owner: owner,
      type: templateType || "service",
      parameters: parametersSpec,
      steps: [
        {
          id: "trigger-flow",
          name: "Trigger Flows Workflow",
          action: "http:backstage:request",
          input: {
            method: "POST",
            path: `/proxy/flows/trigger/${slug}`,
            headers: {
              "Content-Type": "application/json",
            },
            body,
            continueOnBadResponse: true,
          },
        },
      ],
      output: {
        text: [
          {
            title: "Response",
            content: outputContent,
          },
        ],
      },
    },
  };

  return stringify(doc, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    blockQuote: "literal",
  });
}

function buildParametersSpec(
  parameters?: TemplateParameter[],
): Record<string, unknown>[] {
  if (!parameters || parameters.length === 0) {
    return [
      {
        title: "Confirm",
        description: "This will trigger the workflow.",
        properties: {},
      },
    ];
  }

  const requiredFields = parameters
    .filter((p) => p.required)
    .map((p) => p.name);

  const properties: Record<string, Record<string, unknown>> = {};
  for (const param of parameters) {
    const prop: Record<string, unknown> = {
      title: param.title.replace(/\s*\n\s*/g, " ").trim(),
      type: param.type,
    };
    if (param.description) {
      prop.description = param.description.replace(/\s*\n\s*/g, " ").trim();
    }
    if (param.default !== undefined) {
      prop.default = coerce(param.default, param.type);
    }
    if (param.enum && param.enum.length > 0) {
      prop.enum = param.enum.map((v) => coerce(v, param.type));
    }
    properties[param.name] = prop;
  }

  const step: Record<string, unknown> = {
    title: "Parameters",
    properties,
  };
  if (requiredFields.length > 0) {
    step.required = requiredFields;
  }

  return [step];
}

function buildBody(parameters?: TemplateParameter[]): Record<string, string> {
  const body: Record<string, string> = {
    userRef: "${{ user.ref }}",
  };
  if (parameters && parameters.length > 0) {
    for (const param of parameters) {
      body[param.name] = `\${{ parameters.${param.name} }}`;
    }
  }
  return body;
}

// The platform config delivers all values as strings. The YAML encoder would
// quote them as-is (e.g. "3" instead of 3), breaking Backstage form defaults
// and enums. Convert to the proper JS type so the encoder emits them unquoted.
function coerce(
  value: string,
  type: TemplateParameter["type"],
): string | number | boolean {
  switch (type) {
    case "number":
      return Number(value);
    case "boolean":
      return value === "true";
    default:
      return value;
  }
}

export function generateLocationYAML(
  baseUrl: string,
  blocks: BlockConfig[],
  namespace: string | undefined,
  urlSecret: string,
): string {
  const metadata: Record<string, unknown> = {
    name: `flows-templates-${endpointSlug(baseUrl)}`,
  };
  if (namespace) {
    metadata.namespace = namespace;
  }
  const pathPrefix = `/${urlSecret}`;

  const doc = {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Location",
    metadata,
    spec: {
      type: "url",
      targets: blocks.map(
        (b) => `${baseUrl}${pathPrefix}/templates/${b.slug}.yaml`,
      ),
    },
  };

  return stringify(doc, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}
