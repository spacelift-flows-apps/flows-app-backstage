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

  const metadata: string[] = [
    `  name: ${slug}`,
    `  title: ${yamlEscape(title)}`,
  ];
  if (description) {
    metadata.push(`  description: ${yamlEscape(singleLine(description))}`);
  }
  if (tags && tags.length > 0) {
    metadata.push(`  tags:`);
    for (const tag of tags) {
      metadata.push(`    - ${yamlEscape(tag)}`);
    }
  }

  const parametersYAML = renderParameters(parameters);
  const bodyYAML = renderBody(parameters);

  const output = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
${metadata.join("\n")}
spec:
  owner: ${yamlEscape(owner)}
  type: ${yamlEscape(templateType || "service")}
${parametersYAML}
  steps:
    - id: trigger-flow
      name: Trigger Flows Workflow
      action: http:backstage:request
      input:
        method: POST
        path: /proxy/flows/trigger/${slug}
        headers:
          Content-Type: application/json
${bodyYAML}
        continueOnBadResponse: true
  output:
    text:
      - title: Response
        content: |
          {%- if steps['trigger-flow'].output.code | int >= 400 %}
          **Request failed (status \${{ steps['trigger-flow'].output.code }})**

          Please contact the Platform team for assistance.
          {%- else %}
          **Status:** \${{ steps['trigger-flow'].output.code }}
          **Body:** \${{ steps['trigger-flow'].output.body }}
          {%- endif %}`;

  return output;
}

function renderParameters(parameters?: TemplateParameter[]): string {
  if (!parameters || parameters.length === 0) {
    return `  parameters:
    - title: Confirm
      description: This will trigger the workflow.
      properties: {}`;
  }

  const lines: string[] = [`  parameters:`];
  lines.push(`    - title: Parameters`);

  const requiredFields = parameters.filter((p) => p.required);
  if (requiredFields.length > 0) {
    lines.push(`      required:`);
    for (const field of requiredFields) {
      lines.push(`        - ${field.name}`);
    }
  }

  lines.push(`      properties:`);
  for (const param of parameters) {
    lines.push(`        ${param.name}:`);
    lines.push(`          title: ${yamlEscape(singleLine(param.title))}`);
    lines.push(`          type: ${param.type}`);
    if (param.description) {
      lines.push(
        `          description: ${yamlEscape(singleLine(param.description))}`,
      );
    }
    if (param.default !== undefined) {
      lines.push(`          default: ${yamlEscape(param.default)}`);
    }
    if (param.enum && param.enum.length > 0) {
      lines.push(`          enum:`);
      for (const val of param.enum) {
        lines.push(`            - ${yamlEscape(val)}`);
      }
    }
  }

  return lines.join("\n");
}

function renderBody(parameters?: TemplateParameter[]): string {
  if (!parameters || parameters.length === 0) {
    return `        body: {}`;
  }

  const lines: string[] = [`        body:`];
  for (const param of parameters) {
    lines.push(`          ${param.name}: \${{ parameters.${param.name} }}`);
  }
  return lines.join("\n");
}

export function generateLocationYAML(
  baseUrl: string,
  blocks: BlockConfig[],
  namespace?: string,
): string {
  const lines: string[] = [
    `apiVersion: backstage.io/v1alpha1`,
    `kind: Location`,
    `metadata:`,
    `  name: flows-templates-${new URL(baseUrl).hostname.split(".")[0]}`,
  ];
  if (namespace) {
    lines.push(`  namespace: ${namespace}`);
  }
  lines.push(`spec:`, `  type: url`, `  targets:`);
  for (const block of blocks) {
    lines.push(`    - ${baseUrl}/templates/${block.slug}.yaml`);
  }
  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").trim();
}

function yamlEscape(value: string): string {
  if (
    value.includes(":") ||
    value.includes("#") ||
    value.includes("'") ||
    value.includes('"') ||
    value.includes("{") ||
    value.includes("}") ||
    value.includes("[") ||
    value.includes("]") ||
    value.includes(",") ||
    value.includes("&") ||
    value.includes("*") ||
    value.includes("!") ||
    value.includes("|") ||
    value.includes(">") ||
    value.includes("%") ||
    value.includes("@") ||
    value.includes("`") ||
    value.startsWith(" ") ||
    value.endsWith(" ")
  ) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
