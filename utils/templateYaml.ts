interface BlockConfig {
  slug: string;
  title: string;
  description?: string;
  owner: string;
  templateType?: string;
  tags?: string[];
}

export function generateTemplateYaml(blockConfig: BlockConfig): string {
  const { slug, title, description, owner, templateType, tags } = blockConfig;

  const metadata: string[] = [
    `  name: ${slug}`,
    `  title: ${yamlEscape(title)}`,
  ];
  if (description) {
    metadata.push(`  description: ${yamlEscape(description)}`);
  }
  if (tags && tags.length > 0) {
    metadata.push(`  tags:`);
    for (const tag of tags) {
      metadata.push(`    - ${yamlEscape(tag)}`);
    }
  }

  const output = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
${metadata.join("\n")}
spec:
  owner: ${yamlEscape(owner)}
  type: ${yamlEscape(templateType || "service")}
  parameters:
    - title: Confirm
      description: This will trigger the workflow.
      properties: {}
  steps:
    - id: trigger-flow
      name: Trigger Flows Workflow
      action: http:backstage:request
      input:
        method: POST
        path: /proxy/flows/trigger/${slug}
        headers:
          Content-Type: application/json
        body: {}
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

export function generateMultiDocumentYaml(blocks: BlockConfig[]): string {
  return blocks.map(generateTemplateYaml).join("\n---\n");
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
