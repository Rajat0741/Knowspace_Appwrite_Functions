# KnowSpace — Appwrite Functions

This repository contains the Appwrite Functions used by the KnowSpace project.

These functions power backend workflows such as processing content, handling webhooks, managing metadata, and integrating external services.

---

## Contents

- Overview
- Prerequisites
- Local development
- Deploying with Appwrite CLI
- Environment variables
- Observability (logs, retries)
- Security and best practices
- Contributing and license

---

## Overview

Appwrite Functions here are written in JavaScript and designed to be:
- Event-driven (database/storage/auth events)
- On-demand (HTTP triggers)
- Maintainable and modular (one folder per function)

Suggested structure (adjust to your actual layout):

```
functions/
  example-function/
    index.js
    package.json
    README.md
    .env.example
```

Replace the placeholders below with your real function names and responsibilities.

---

## Prerequisites

- Node.js (LTS)
- Appwrite project with:
  - Project ID
  - API Endpoint
  - API Key with appropriate permissions (for deployments and runtime if needed)
- Appwrite CLI installed and authenticated

```bash
npm i -g appwrite
appwrite login
appwrite client --set-endpoint https://cloud.appwrite.io/v1
appwrite client --set-project <your_project_id>
```

---

## Local development

You can run and iterate on functions locally:

- Install dependencies inside each function directory:
  ```bash
  cd functions/<function-name>
  npm install
  ```
- Add a `.env.local` (or use Appwrite secrets at runtime). See the example below.

While Appwrite doesn’t emulate every cloud event locally, you can:
- Create small harness scripts to call your handler with sample payloads
- Use HTTP-triggered functions for quick local testing

---

## Deploying with Appwrite CLI

From the repository root or from a function folder:

```bash
# Create a new function (one-time)
appwrite functions create \
  --name "<Function Name>" \
  --runtime node-20.0

# Deploy source (zip of current directory)
appwrite functions create-deployment \
  --function-id "<function_id_or_name>" \
  --entrypoint "index.js" \
  --activate
```

Notes:
- Set the runtime to your target Node.js version available in Appwrite.
- If you keep each function in its own folder, run the deployment command from that folder.
- For updates, repeat the `create-deployment` command with `--activate`.

Configure triggers in the Appwrite Console:
- Events (e.g., `databases.*.collections.*.documents.*.create`)
- HTTP endpoint (enable “Execute function via HTTP”)
- Schedules (CRON)

---

## Environment variables

Provide an `.env.example` in each function directory. At runtime, store secrets in Appwrite function variables, not in code.

Typical variables:

```
APPWRITE_ENDPOINT=https://cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your_project_id
APPWRITE_API_KEY=key_with_needed_scopes

# Optional service integrations
IMAGEKIT_PRIVATE_KEY=...
IMAGEKIT_URL_ENDPOINT=...
EXTERNAL_API_KEY=...

# App-specific config
KNOWSPACE_BASE_URL=https://your-app.example.com
```

In Vite frontend, use `VITE_` prefix (kept in the main app repo). In functions, plain names are fine, but keep them in Appwrite function variables.

---

## Observability

- Logs: View per-function logs in Appwrite Console (Functions → Your Function → Logs).
- Retries: For event-driven functions, confirm retry behavior and idempotency in your code.
- Metrics: Consider adding lightweight timing and error counters.

---

## Security and best practices

- Never commit secrets. Use Appwrite function variables.
- Validate all inputs (headers, query, JSON body) for HTTP functions.
- Make handlers idempotent for event triggers.
- Enforce least-privilege on the API key used for deployments/runtime.
- Add timeouts and guardrails around external calls.

---

## Contributing

- Open an issue or PR with clear context and reproduction steps.
- Follow conventional commits or a consistent commit style.
- Keep function folders self-contained and documented (README.md per function is ideal).

---

## License

MIT — see [LICENSE](LICENSE) if present.
