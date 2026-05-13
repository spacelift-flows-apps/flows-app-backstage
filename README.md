# Backstage Integration (Flows App)

A Flows app that integrates with [Backstage](https://backstage.io) Software
Templates. Each Backstage Entrypoint block registers as a Software Template in
Backstage, letting you trigger Flows workflows from Backstage's "Create" page.

## App Configuration

**Required:**

- **Backstage URL** -- base URL of the Backstage backend (e.g.,
  `https://backstage.example.com:7007`).
- **Backstage API Token** -- static token for authenticating with Backstage
  (configured in `backend.auth.externalAccess`).

**Optional:**

- **Namespace** -- grouping identifier for templates in the Backstage catalog,
  used to isolate across teams or environments (e.g., `platform-team`).

An auth token for incoming requests from Backstage is auto-generated on install
and exposed as a signal.

## Blocks

### Backstage Entrypoint

Entrypoint block that registers a Software Template in Backstage. When a user
submits the template form in Backstage, the workflow is triggered.

Owner, type, and tags fields offer suggestions fetched from the Backstage
catalog. The output schema is dynamically updated to reflect the configured form
parameters.

**Config:**

- **Slug** (required) -- URL-friendly identifier (lowercase, numbers, hyphens).
- **Owner** (required) -- Backstage owner reference (e.g.,
  `group:default/platform-team`). Suggests values from the catalog.
- **Title** (required) -- display title in Backstage's template catalog.
- **Description** -- shown in Backstage's template catalog.
- **Type** -- template type for filtering (default: `service`). Suggests
  existing types from the catalog.
- **Tags** -- tags for filtering in Backstage.
- **Success Message** -- message shown after a successful trigger (default:
  "Workflow triggered successfully.").
- **Form Parameters** -- form fields shown when launching the template. Each
  parameter defines a name, title, type (`string`, `number`, `boolean`),
  and optionally whether it's required, a default value, and allowed values
  (enum). Incoming requests are validated against these parameters.

## Backstage Setup

Most required backend plugins come pre-installed with
`npx @backstage/create-app`. You need to add the HTTP request scaffolder action:

```bash
yarn --cwd packages/backend add @roadiehq/scaffolder-backend-module-http-request
```

Register it in `packages/backend/src/index.ts`:

```ts
backend.add(import("@roadiehq/scaffolder-backend-module-http-request"));
```

### Environment Variables

Set these before starting Backstage:

```bash
export BACKSTAGE_API_TOKEN=<any-secret-string-you-choose>
export FLOWS_API_TOKEN=<auth-token-from-signals-tab>
export FLOWS_AUTH_HEADER="Bearer $FLOWS_API_TOKEN"
```

### app-config.yaml

Add the following (replace placeholders with values from the app's installation
instructions):

```yaml
backend:
  auth:
    externalAccess:
      - type: static
        options:
          token: ${BACKSTAGE_API_TOKEN}
          subject: flows-service
  reading:
    allow:
      - host: <APP_ENDPOINT_HOST>

catalog:
  locations:
    - type: url
      target: <APP_ENDPOINT>/templates.yaml
      rules:
        - allow: [Location, Template]

proxy:
  endpoints:
    "/flows":
      target: <APP_ENDPOINT>
      changeOrigin: true
      headers:
        Authorization: ${FLOWS_AUTH_HEADER}
```

Restart Backstage (`yarn dev`). Templates appear in the "Create" page shortly
after the corresponding blocks are confirmed. The app triggers a catalog refresh
automatically when blocks are confirmed, updated, or removed.

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
npm install
```

### Available Scripts

```bash
npm run typecheck    # Type checking
npm run format       # Code formatting
npm run bundle       # Create deployment bundle
```

## Releasing

Follow [Semantic Versioning](https://semver.org/). Tag-based releases:

```bash
git tag v1.0.0
git push origin v1.0.0
```

CI automatically creates the release and updates the version registry.
