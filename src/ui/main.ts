import "./styles.css";
import { BUNDLE_PRESETS, type PresetKey } from "../core/fixtures";
import { parseHoconOrJson } from "../core/hoconParser";
import {
  deleteByokProfile,
  loadByokProfile,
  saveByokProfile,
} from "../core/peerRuntime";
import type { AgentManifest, AgentNetwork, AuditReport, PeerHopResult, RouterMode } from "../core/types";
import { runByokAgentTurn } from "../runtime/byokRouter";
import { runDeterministicAgentTurn, type AgentTurnOutput } from "../runtime/deterministicRouter";
import {
  createInitialWorkbenchState,
  createSiteActions,
  type WorkbenchState,
} from "../runtime/siteActions";

interface ModalPromptOptions {
  title: string;
  body: string;
  details: Array<[string, string]>;
  approveLabel: string;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing DOM element #${id}`);
  }
  return found as T;
}

export function mountManifestLabApp(): void {
  let state: WorkbenchState = createInitialWorkbenchState();
  let activeFilter: "all" | "fail" | "warn" = "all";
  let lastTriggerEl: HTMLElement | null = null;

  const themeBtn = el<HTMLButtonElement>("theme-toggle-btn");
  const remoteUrlInput = el<HTMLInputElement>("remote-manifest-url");
  const fetchRemoteBtn = el<HTMLButtonElement>("fetch-remote-btn");
  const fileInput = el<HTMLInputElement>("local-file-input");
  const loaderFeedback = el<HTMLDivElement>("loader-feedback");

  const manifestEditor = el<HTMLTextAreaElement>("manifest-editor");
  const networkEditor = el<HTMLTextAreaElement>("network-editor");
  const linksEditor = el<HTMLTextAreaElement>("links-editor");
  const runAuditBtn = el<HTMLButtonElement>("run-audit-btn");
  const exportReportBtn = el<HTMLButtonElement>("export-report-btn");
  const resetWorkspaceBtn = el<HTMLButtonElement>("reset-workspace-btn");
  const stateVersionLabel = el<HTMLSpanElement>("state-version-label");

  const auditEmpty = el<HTMLDivElement>("audit-empty-state");
  const auditLoading = el<HTMLDivElement>("audit-loading-state");
  const auditError = el<HTMLDivElement>("audit-error-state");
  const auditResults = el<HTMLDivElement>("audit-results");
  const auditSummary = el<HTMLDivElement>("audit-summary");
  const findingsList = el<HTMLUListElement>("findings-list");

  const routerModeSelect = el<HTMLSelectElement>("router-mode-select");
  const byokFields = el<HTMLDivElement>("byok-fields");
  const byokBaseUrl = el<HTMLInputElement>("byok-base-url");
  const byokModelName = el<HTMLInputElement>("byok-model-name");
  const byokApiKey = el<HTMLInputElement>("byok-api-key");
  const saveByokBtn = el<HTMLButtonElement>("save-byok-btn");
  const deleteByokBtn = el<HTMLButtonElement>("delete-byok-btn");
  const byokStatusNote = el<HTMLParagraphElement>("byok-status-note");

  const agentForm = el<HTMLFormElement>("agent-chat-form");
  const agentPromptInput = el<HTMLInputElement>("agent-prompt-input");
  const sendAgentBtn = el<HTMLButtonElement>("send-agent-btn");
  const agentEmpty = el<HTMLDivElement>("agent-empty-state");
  const agentLoading = el<HTMLDivElement>("agent-loading-state");
  const agentError = el<HTMLDivElement>("agent-error-state");
  const agentOutputBox = el<HTMLDivElement>("agent-output-box");

  const peerUrlInput = el<HTMLInputElement>("peer-url-input");
  const peerRequestInput = el<HTMLInputElement>("peer-request-input");
  const runPeerHopBtn = el<HTMLButtonElement>("run-peer-hop-btn");
  const peerEmpty = el<HTMLDivElement>("peer-empty-state");
  const peerLoading = el<HTMLDivElement>("peer-loading-state");
  const peerError = el<HTMLDivElement>("peer-error-state");
  const peerResultBox = el<HTMLDivElement>("peer-result-box");

  const traceEmpty = el<HTMLDivElement>("trace-empty-state");
  const traceList = el<HTMLOListElement>("trace-list");

  const modalBackdrop = el<HTMLDivElement>("modal-backdrop");
  const modalTitle = el<HTMLHeadingElement>("modal-title");
  const modalBody = el<HTMLParagraphElement>("modal-body");
  const modalDetails = el<HTMLDListElement>("modal-details");
  const modalApproveBtn = el<HTMLButtonElement>("modal-approve-btn");
  const modalCancelBtn = el<HTMLButtonElement>("modal-cancel-btn");

  function openConfirmationModal(opts: ModalPromptOptions): Promise<boolean> {
    lastTriggerEl = document.activeElement as HTMLElement | null;
    modalTitle.textContent = opts.title;
    modalBody.textContent = opts.body;
    modalApproveBtn.textContent = opts.approveLabel;
    modalDetails.replaceChildren();

    for (const [k, v] of opts.details) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      modalDetails.append(dt, dd);
    }

    modalBackdrop.hidden = false;
    modalApproveBtn.focus();

    return new Promise((resolve) => {
      const cleanup = (accepted: boolean) => {
        modalBackdrop.hidden = true;
        modalApproveBtn.removeEventListener("click", onApprove);
        modalCancelBtn.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKeyDown);
        lastTriggerEl?.focus();
        resolve(accepted);
      };
      const onApprove = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cleanup(false);
        }
      };

      modalApproveBtn.addEventListener("click", onApprove);
      modalCancelBtn.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKeyDown);
    });
  }

  const actions = createSiteActions({
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
      syncUiFromState();
    },
    requestIrreversibleConfirm: (summary, expectedVersion) =>
      openConfirmationModal({
        title: "Confirm Irreversible Workspace Reset",
        body: summary,
        details: [
          ["Action", "website_clear_audit_workspace"],
          ["Effect", "irreversible"],
          ["State Version", String(expectedVersion)],
        ],
        approveLabel: "Confirm Reset",
      }),
    requestPeerConsent: (req) =>
      openConfirmationModal({
        title: "Approve Cross-Origin Peer Request",
        body: "Review destination origin and request preview before the browser fetches the peer manifest.",
        details: [
          ["Peer Origin", req.peerOrigin],
          ["Network", `${req.displayLabel} (${req.networkName})`],
          ["Request Preview", req.requestPreview140],
          [
            "Allowed sly_data",
            req.allowedSlyFields.length > 0 ? req.allowedSlyFields.join(", ") : "none (deny-by-default)",
          ],
          ["BYOK Key Shared", "Never (stays in caller browser only)"],
        ],
        approveLabel: "Allow Peer Fetch",
      }),
  });

  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__MANIFEST_LAB_ACTIONS__ = actions;
    if (window.location?.origin?.startsWith("http")) {
      peerUrlInput.value = `${window.location.origin}/peer_fixture/civic_directory`;
    }
  }

  function setLoaderStatus(message: string, isError = false): void {
    loaderFeedback.hidden = false;
    loaderFeedback.textContent = message;
    loaderFeedback.className = isError ? "status-banner state-error" : "status-banner";
  }

  function syncEditorsToState(): void {
    state = {
      ...state,
      manifestText: manifestEditor.value,
      networkText: networkEditor.value,
      linksText: linksEditor.value,
    };
  }

  function renderReport(report: AuditReport | null): void {
    auditLoading.hidden = true;
    auditError.hidden = true;

    if (!report) {
      auditEmpty.hidden = false;
      auditResults.hidden = true;
      exportReportBtn.disabled = true;
      return;
    }

    auditEmpty.hidden = true;
    auditResults.hidden = false;
    exportReportBtn.disabled = false;

    auditSummary.replaceChildren();
    const overallBadge = document.createElement("span");
    overallBadge.className = `badge ${report.conformant ? "badge-pass" : "badge-fail"}`;
    overallBadge.textContent = report.conformant ? "CONFORMANT" : "NON-CONFORMANT";

    const passBadge = document.createElement("span");
    passBadge.className = "badge badge-pass";
    passBadge.textContent = `${report.counts.pass} Pass`;

    const warnBadge = document.createElement("span");
    warnBadge.className = "badge badge-warn";
    warnBadge.textContent = `${report.counts.warn} Warn`;

    const failBadge = document.createElement("span");
    failBadge.className = "badge badge-fail";
    failBadge.textContent = `${report.counts.fail} Fail`;

    auditSummary.append(overallBadge, passBadge, warnBadge, failBadge);

    const visible = report.findings.filter((f) => {
      if (activeFilter === "all") return true;
      return f.severity === activeFilter;
    });

    findingsList.replaceChildren();
    if (visible.length === 0) {
      const li = document.createElement("li");
      li.className = "finding-item";
      li.textContent = `No findings match filter "${activeFilter}".`;
      findingsList.append(li);
      return;
    }

    for (const f of visible) {
      const li = document.createElement("li");
      li.className = "finding-item";

      const top = document.createElement("div");
      top.className = "finding-top";

      const title = document.createElement("span");
      title.className = "finding-title";
      title.textContent = `${f.ruleId}: ${f.title}`;

      const badge = document.createElement("span");
      badge.className = `badge badge-${f.severity}`;
      badge.textContent = f.severity.toUpperCase();
      top.append(title, badge);

      const meta = document.createElement("div");
      meta.className = "finding-meta";
      meta.textContent = `${f.specSection} | ${f.path}`;

      const msg = document.createElement("div");
      msg.textContent = f.message;

      li.append(top, meta, msg);
      if (f.severity !== "pass") {
        const rem = document.createElement("p");
        rem.className = "finding-remediation";
        rem.textContent = `Fix: ${f.remediation}`;
        li.append(rem);
      }
      findingsList.append(li);
    }
  }

  function renderPeerHop(hop: PeerHopResult | null): void {
    peerLoading.hidden = true;
    peerError.hidden = true;

    if (!hop) {
      peerEmpty.hidden = false;
      peerResultBox.hidden = true;
      return;
    }

    peerEmpty.hidden = true;
    if (!hop.ok && hop.status === "error") {
      peerError.hidden = false;
      peerError.textContent = hop.reason ?? "Peer hop failed.";
      peerResultBox.hidden = true;
      return;
    }

    peerResultBox.hidden = false;
    peerResultBox.replaceChildren();

    const statusLine = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `Status: ${hop.status.toUpperCase()} (${hop.peerOrigin})`;
    statusLine.append(strong);

    const bodyLine = document.createElement("p");
    bodyLine.textContent = hop.reply ?? hop.reason ?? "Completed.";

    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(
      {
        networkName: hop.networkName,
        forwardedSlyKeys: hop.forwardedSlyKeys,
        strippedSlyKeys: hop.strippedSlyKeys,
        byokHeaderSentToPeer: hop.byokHeaderSentToPeer,
      },
      null,
      2
    );

    peerResultBox.append(statusLine, bodyLine, pre);
  }

  function renderTrace(): void {
    if (state.trace.length === 0) {
      traceEmpty.hidden = false;
      traceList.hidden = true;
      traceList.replaceChildren();
      return;
    }

    traceEmpty.hidden = true;
    traceList.hidden = false;
    traceList.replaceChildren();

    for (const item of state.trace) {
      const li = document.createElement("li");
      li.className = "trace-item";

      const head = document.createElement("div");
      head.className = "finding-meta";
      head.textContent = `${item.timestampIso} | ${item.kind.toUpperCase()} | ${item.actor}${
        item.origin ? ` | ${item.origin}` : ""
      }`;

      const summary = document.createElement("div");
      summary.textContent = item.summary;

      li.append(head, summary);
      traceList.append(li);
    }
  }

  function syncUiFromState(): void {
    if (manifestEditor.value !== state.manifestText) {
      manifestEditor.value = state.manifestText;
    }
    if (networkEditor.value !== state.networkText) {
      networkEditor.value = state.networkText;
    }
    if (linksEditor.value !== state.linksText) {
      linksEditor.value = state.linksText;
    }
    stateVersionLabel.textContent = `State v${state.version}`;
    renderReport(state.lastReport);
    renderPeerHop(state.lastPeerHop);
    renderTrace();
  }

  function renderAgentOutput(output: AgentTurnOutput): void {
    agentEmpty.hidden = true;
    agentLoading.hidden = true;
    agentError.hidden = true;
    agentOutputBox.hidden = false;
    agentOutputBox.replaceChildren();

    const meta = document.createElement("p");
    meta.className = "finding-meta";
    meta.textContent = `Router: ${output.routerLabel} | Agent path: ${output.agentPath.join(" -> ")}`;

    const reply = document.createElement("p");
    reply.textContent = output.replyText;

    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(
      output.toolCalls.map((tc) => ({
        tool: tc.tool,
        status: tc.result.status,
        effect: tc.result.effect,
        ok: tc.result.ok,
      })),
      null,
      2
    );

    agentOutputBox.append(meta, reply, pre);
  }

  // Hydrate saved BYOK profile if present
  const existingProfile = loadByokProfile();
  if (existingProfile) {
    byokBaseUrl.value = existingProfile.routerBaseUrl;
    byokModelName.value = existingProfile.modelName;
    byokApiKey.value = existingProfile.apiKey;
  }

  // Initial state hydration
  syncUiFromState();

  themeBtn.addEventListener("click", () => {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    themeBtn.setAttribute("aria-pressed", String(next === "dark"));
    themeBtn.textContent = next === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme";
  });

  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.preset as PresetKey;
      const res = actions.load_bundle_preset({ preset: key });
      if (res.ok) {
        setLoaderStatus(`Loaded preset "${key}".`);
      } else {
        setLoaderStatus(res.reason ?? "Failed to load preset.", true);
      }
    });
  });

  fetchRemoteBtn.addEventListener("click", async () => {
    const rawUrl = remoteUrlInput.value.trim();
    if (!rawUrl) {
      setLoaderStatus("Enter an agent-manifest.json URL before fetching.", true);
      return;
    }
    setLoaderStatus(`Fetching ${rawUrl}...`);
    try {
      const manifestResp = await fetch(rawUrl, { credentials: "omit" });
      if (!manifestResp.ok) {
        throw new Error(`HTTP ${manifestResp.status} fetching manifest.`);
      }
      const manifestJson = (await manifestResp.json()) as AgentManifest;
      const hoconRel = manifestJson.networks?.[0]?.hocon;
      if (!hoconRel) {
        throw new Error("Remote manifest has no networks[0].hocon entry.");
      }
      const resolvedUrl = new URL(rawUrl, window.location.href);
      const netUrl = new URL(hoconRel, resolvedUrl).toString();
      const netResp = await fetch(netUrl, { credentials: "omit" });
      if (!netResp.ok) {
        throw new Error(`HTTP ${netResp.status} fetching ${netUrl}.`);
      }
      const netText = await netResp.text();

      let linksText = JSON.stringify({ version: 1, networks: {} }, null, 2);
      try {
        const linksResp = await fetch(new URL("./links.json", resolvedUrl).toString(), {
          credentials: "omit",
        });
        if (linksResp.ok) {
          linksText = await linksResp.text();
        }
      } catch {
        // Optional links.json fallback stays default empty map
      }

      state = {
        ...state,
        version: state.version + 1,
        activePreset: "custom",
        bundleLabel: `Remote: ${resolvedUrl.origin}`,
        manifestText: JSON.stringify(manifestJson, null, 2),
        networkText: netText,
        linksText,
        lastReport: null,
      };
      syncUiFromState();
      setLoaderStatus(`Loaded remote bundle from ${resolvedUrl.origin}.`);
    } catch (err) {
      setLoaderStatus(
        err instanceof Error ? err.message : "Failed to fetch remote bundle (check CORS).",
        true
      );
    }
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const parsed = parseHoconOrJson(content) as Record<string, unknown>;
      if (Array.isArray(parsed.networks)) {
        manifestEditor.value = content;
        setLoaderStatus(`Loaded ${file.name} into agent-manifest.json editor.`);
      } else if (Array.isArray(parsed.tools)) {
        networkEditor.value = content;
        setLoaderStatus(`Loaded ${file.name} into network definition editor.`);
      } else if (typeof parsed.networks === "object") {
        linksEditor.value = content;
        setLoaderStatus(`Loaded ${file.name} into links.json editor.`);
      } else {
        throw new Error("Unrecognized file structure; expected networks[] or tools[].");
      }
      state = { ...state, activePreset: "custom", bundleLabel: `File: ${file.name}` };
      syncEditorsToState();
    } catch (err) {
      setLoaderStatus(err instanceof Error ? err.message : "Unable to read local file.", true);
    }
  });

  runAuditBtn.addEventListener("click", () => {
    syncEditorsToState();
    auditEmpty.hidden = true;
    auditError.hidden = true;
    auditResults.hidden = true;
    auditLoading.hidden = false;

    const res = actions.run_conformance_audit();
    if (!res.ok) {
      auditLoading.hidden = true;
      auditError.hidden = false;
      auditError.textContent = res.reason ?? "Bundle audit failed.";
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeFilter = (btn.dataset.filter as "all" | "fail" | "warn") ?? "all";
      document.querySelectorAll<HTMLButtonElement>(".filter-btn").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      renderReport(state.lastReport);
    });
  });

  exportReportBtn.addEventListener("click", () => {
    if (!state.lastReport) return;
    const blob = new Blob([JSON.stringify(state.lastReport, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "manifest-lab-audit-report.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  resetWorkspaceBtn.addEventListener("click", async () => {
    const res = await actions.clear_audit_workspace({ expected_version: state.version });
    if (res.ok) {
      setLoaderStatus("Audit report and trace cleared.");
    } else {
      setLoaderStatus(res.reason ?? "Reset cancelled.", true);
    }
  });

  routerModeSelect.addEventListener("change", () => {
    const mode = routerModeSelect.value as RouterMode;
    state = { ...state, routerMode: mode };
    byokFields.hidden = mode !== "byok";
    byokStatusNote.textContent =
      mode === "byok"
        ? "Active: Visitor BYOK Router. Key stays in localStorage and goes only to your selected router."
        : "Active: Offline Deterministic Router. Zero external network calls.";
  });

  saveByokBtn.addEventListener("click", () => {
    saveByokProfile({
      routerBaseUrl: byokBaseUrl.value.trim(),
      modelName: byokModelName.value.trim(),
      apiKey: byokApiKey.value.trim(),
    });
    byokStatusNote.textContent = `Saved BYOK profile (${byokModelName.value.trim()}) in origin localStorage.`;
  });

  deleteByokBtn.addEventListener("click", () => {
    deleteByokProfile();
    byokApiKey.value = "";
    byokStatusNote.textContent = "Deleted stored BYOK credentials from localStorage.";
  });

  document.querySelectorAll<HTMLButtonElement>(".sample-prompt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      agentPromptInput.value = btn.dataset.prompt ?? "";
      agentPromptInput.focus();
    });
  });

  agentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = agentPromptInput.value.trim();
    if (!prompt) return;

    syncEditorsToState();
    agentEmpty.hidden = true;
    agentError.hidden = true;
    agentOutputBox.hidden = true;
    agentLoading.hidden = false;
    sendAgentBtn.disabled = true;

    try {
      let output: AgentTurnOutput;
      if (state.routerMode === "byok") {
        const profile = {
          routerBaseUrl: byokBaseUrl.value.trim(),
          modelName: byokModelName.value.trim(),
          apiKey: byokApiKey.value.trim(),
        };
        const selfNetwork = BUNDLE_PRESETS.conforming.network as AgentNetwork;
        output = await runByokAgentTurn(prompt, profile, selfNetwork, actions);
      } else {
        output = await runDeterministicAgentTurn(prompt, actions);
      }
      renderAgentOutput(output);
    } catch (err) {
      agentLoading.hidden = true;
      agentError.hidden = false;
      agentError.textContent = err instanceof Error ? err.message : "Agent turn failed.";
    } finally {
      sendAgentBtn.disabled = false;
    }
  });

  runPeerHopBtn.addEventListener("click", async () => {
    syncEditorsToState();
    peerEmpty.hidden = true;
    peerError.hidden = true;
    peerResultBox.hidden = true;
    peerLoading.hidden = false;

    const res = await actions.simulate_peer_hop({
      peerUrl: peerUrlInput.value.trim(),
      request: peerRequestInput.value.trim(),
    });
    if (!res.ok && res.status === "refused") {
      peerLoading.hidden = true;
      peerError.hidden = false;
      peerError.textContent = res.reason ?? "Peer hop blocked.";
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("main-content")) {
  mountManifestLabApp();
}
