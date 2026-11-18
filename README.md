# ManifestLab: Open Agentic Web MVP 0.2 Conformance Workbench

ManifestLab is a static, browser-executed Open Agentic Website and community developer workbench built for the Open Agentic Web Challenge (`openagenticweb.devpost.com`).

## What It Does

1. **16-Rule MVP Profile 0.2 Conformance Auditor**: Inspects `agent-manifest.json`, `.network.json` / `.hocon`, `links.json`, and `agent-mcp.json` bundles for front-agent resolution, JSON Schema input validity, local agent reachability, data-only expansion, bounded execution budgets, HTTPS peer rules, `peer_policy` enforcement, BYOK credential hygiene, `sly_data` deny-by-default rules, unsafe instruction directives, and action safety.
2. **Browser Agent Runtime (`manifest_lab.network.json`)**: Runs a two-agent network (`manifest_coordinator` and `boundary_verifier`) in the browser with five registered `website_*` site actions, state version checks, and modal confirmation on irreversible actions (`clear_audit_workspace`).
3. **Zero-Cost Deterministic Mode + Visitor BYOK**: Defaults to an Offline Deterministic Router ($0, zero external API calls) and also supports visitor-supplied OpenAI-compatible, Mozilla Otari (`https://api.otari.ai/api/v1`), or local Ollama routers stored strictly in origin `localStorage`.
4. **Two-Origin Peer Boundary Simulator**: Demonstrates cross-origin manifest loading against `./peer_fixture/civic_directory` with explicit consent previews (origin and first 140 characters of request), `sly_data` allowlist filtering, and BYOK credential isolation.

## Local Development and Verification

```bash
npm install
npm run typecheck
npm test
npm run build
```

Serve the built static bundle (`dist/`) locally on `http://127.0.0.1:4173` to test live browser peer-fixture fetching:

```bash
npx vite preview --host 127.0.0.1 --port 4173
```

## Published Open Agentic Web Files

- `public/agent-manifest.json`
- `public/manifest_lab.hocon`
- `public/manifest_lab.network.json`
- `public/links.json`
- `public/agent-mcp.json`
- `public/site-actions.js`
- `public/bridge/action-bridge.html`
- `public/peer_fixture/`
