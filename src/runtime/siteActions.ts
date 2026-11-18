import { auditAgenticBundle } from "../core/auditor";
import { BUNDLE_PRESETS, type PresetKey } from "../core/fixtures";
import { expandReplacementStrings, parseHoconOrJson } from "../core/hoconParser";
import { executePeerHop } from "../core/peerRuntime";
import type {
  ActionInvocationResult,
  AgentManifest,
  AgentNetwork,
  AuditReport,
  ExecutionTraceEntry,
  LinksMap,
  PeerConsentRequest,
  PeerHopResult,
  RouterMode,
} from "../core/types";

export interface WorkbenchState {
  version: number;
  activePreset: PresetKey | "custom";
  bundleLabel: string;
  manifestText: string;
  networkText: string;
  linksText: string;
  lastReport: AuditReport | null;
  lastPeerHop: PeerHopResult | null;
  routerMode: RouterMode;
  trace: ExecutionTraceEntry[];
}

export interface SiteActionHandlers {
  getState: () => WorkbenchState;
  setState: (updater: (prev: WorkbenchState) => WorkbenchState) => void;
  requestIrreversibleConfirm: (summary: string, expectedVersion: number) => Promise<boolean>;
  requestPeerConsent: (req: PeerConsentRequest) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  slyDataProvider?: () => Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function traceId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export function createInitialWorkbenchState(): WorkbenchState {
  const preset = BUNDLE_PRESETS.conforming;
  return {
    version: 1,
    activePreset: "conforming",
    bundleLabel: preset.label,
    manifestText: JSON.stringify(preset.manifest, null, 2),
    networkText: JSON.stringify(preset.network, null, 2),
    linksText: JSON.stringify(preset.links ?? { version: 1, networks: {} }, null, 2),
    lastReport: null,
    lastPeerHop: null,
    routerMode: "deterministic",
    trace: [],
  };
}

export function createSiteActions(handlers: SiteActionHandlers) {
  function appendTrace(
    kind: ExecutionTraceEntry["kind"],
    actor: string,
    summary: string,
    origin?: string
  ): void {
    handlers.setState((prev) => ({
      ...prev,
      trace: [
        ...prev.trace,
        {
          id: traceId(),
          timestampIso: nowIso(),
          kind,
          actor,
          summary,
          origin,
        },
      ],
    }));
  }

  return {
    get_workbench_state(): ActionInvocationResult {
      const s = handlers.getState();
      return {
        ok: true,
        status: "succeeded",
        effect: "read",
        data: {
          version: s.version,
          activePreset: s.activePreset,
          bundleLabel: s.bundleLabel,
          routerMode: s.routerMode,
          lastAudit: s.lastReport
            ? {
                conformant: s.lastReport.conformant,
                counts: s.lastReport.counts,
                discoveredPeerUrls: s.lastReport.discoveredPeerUrls,
              }
            : null,
          lastPeerHop: s.lastPeerHop,
        },
      };
    },

    load_bundle_preset(args: { preset?: string }): ActionInvocationResult {
      const key = args?.preset as PresetKey;
      if (!key || !Object.prototype.hasOwnProperty.call(BUNDLE_PRESETS, key)) {
        return {
          ok: false,
          status: "refused",
          effect: "write",
          reason: `Unknown preset "${String(args?.preset)}". Expected one of: conforming, leaky_sly_data, unsafe_peer.`,
        };
      }
      const preset = BUNDLE_PRESETS[key];
      handlers.setState((prev) => ({
        ...prev,
        version: prev.version + 1,
        activePreset: key,
        bundleLabel: preset.label,
        manifestText: JSON.stringify(preset.manifest, null, 2),
        networkText: JSON.stringify(preset.network, null, 2),
        linksText: JSON.stringify(preset.links ?? { version: 1, networks: {} }, null, 2),
        lastReport: null,
      }));
      appendTrace("tool", "website_load_bundle_preset", `Loaded preset "${key}"`);
      return {
        ok: true,
        status: "succeeded",
        effect: "write",
        data: {
          preset: key,
          label: preset.label,
          version: handlers.getState().version,
        },
      };
    },

    run_conformance_audit(): ActionInvocationResult {
      const s = handlers.getState();
      try {
        const manifest = parseHoconOrJson(s.manifestText) as AgentManifest;
        const rawNetwork = parseHoconOrJson(s.networkText) as AgentNetwork;
        const network = expandReplacementStrings(rawNetwork);
        const links = s.linksText.trim()
          ? (parseHoconOrJson(s.linksText) as LinksMap)
          : undefined;
        const report = auditAgenticBundle({
          label: s.bundleLabel,
          manifest,
          network,
          links,
          agentMcp: manifest.agent_mcp,
        });
        handlers.setState((prev) => ({
          ...prev,
          version: prev.version + 1,
          lastReport: report,
        }));
        appendTrace(
          "tool",
          "website_run_conformance_audit",
          `Audited "${s.bundleLabel}": ${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail`
        );
        return {
          ok: true,
          status: "succeeded",
          effect: "write",
          data: report,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Failed to parse bundle JSON/HOCON.";
        appendTrace("error", "website_run_conformance_audit", reason);
        return {
          ok: false,
          status: "refused",
          effect: "write",
          reason,
        };
      }
    },

    async simulate_peer_hop(args: {
      peerUrl?: string;
      request?: string;
    }): Promise<ActionInvocationResult> {
      const s = handlers.getState();
      let callerManifest: AgentManifest;
      let callerNetwork: AgentNetwork;
      let links: LinksMap | undefined;
      try {
        callerManifest = parseHoconOrJson(s.manifestText) as AgentManifest;
        callerNetwork = expandReplacementStrings(parseHoconOrJson(s.networkText) as AgentNetwork);
        links = s.linksText.trim()
          ? (parseHoconOrJson(s.linksText) as LinksMap)
          : undefined;
      } catch (err) {
        return {
          ok: false,
          status: "refused",
          effect: "write",
          reason: err instanceof Error ? err.message : "Invalid bundle syntax.",
        };
      }

      const primaryName = callerManifest.networks?.[0]?.name ?? "";
      const defaultPeer =
        links?.networks?.[primaryName]?.civic_directory ??
        (typeof window !== "undefined" && window.location?.origin?.startsWith("http")
          ? `${window.location.origin}/peer_fixture/civic_directory`
          : "http://127.0.0.1:4173/peer_fixture/civic_directory");

      const peerUrl = args?.peerUrl?.trim() || defaultPeer;
      const requestText =
        args?.request?.trim() ||
        "Which public civic conformance datasets and sample manifests do you index?";

      const slyData = handlers.slyDataProvider
        ? handlers.slyDataProvider()
        : {
            session_locale: "en-US",
            visitor_byok_key: "sk-visitor-private-never-forward",
            internal_note: "caller-only-context",
          };

      const hop = await executePeerHop({
        callerManifest,
        callerNetwork,
        peerNetworkUrl: peerUrl,
        requestText,
        slyData,
        fetchImpl: handlers.fetchImpl,
        requestConsent: async (consentReq) => {
          appendTrace(
            "consent",
            "consent_gate",
            `Requested visitor approval for ${consentReq.peerOrigin} (${consentReq.networkName})`,
            consentReq.peerOrigin
          );
          return handlers.requestPeerConsent(consentReq);
        },
        executePeerLocally: async ({ peerNetwork, frontMan, forwardedSlyData }) => {
          const agentNames = (peerNetwork.tools ?? []).map((a) => a.name).join(", ");
          const forwardedKeys = Object.keys(forwardedSlyData);
          return `Peer "${frontMan}" executed in caller runtime. Agents: [${agentNames}]. Received sly_data keys: [${forwardedKeys.join(", ") || "none"}].`;
        },
      });

      handlers.setState((prev) => ({
        ...prev,
        version: prev.version + 1,
        lastPeerHop: hop,
      }));
      appendTrace(
        "peer",
        "website_simulate_peer_hop",
        hop.ok
          ? `Peer hop succeeded (${hop.peerOrigin}, stripped keys: ${hop.strippedSlyKeys.join(", ") || "none"})`
          : `Peer hop ${hop.status}: ${hop.reason ?? "blocked"}`,
        hop.peerOrigin
      );

      if (hop.status === "cancelled") {
        return {
          ok: false,
          status: "cancelled",
          effect: "write",
          data: hop,
          reason: hop.reason,
        };
      }

      return {
        ok: hop.ok,
        status: hop.ok ? "succeeded" : "refused",
        effect: "write",
        data: hop,
        reason: hop.reason,
      };
    },

    async clear_audit_workspace(args: {
      expected_version?: number;
    }): Promise<ActionInvocationResult> {
      const s = handlers.getState();
      if (typeof args?.expected_version !== "number" || args.expected_version !== s.version) {
        return {
          ok: false,
          status: "refused",
          effect: "irreversible",
          reason: `Version mismatch: expected ${String(args?.expected_version)}, current version is ${s.version}. Read state first.`,
        };
      }

      const confirmed = await handlers.requestIrreversibleConfirm(
        "Clear current audit report, peer hop result, and execution trace?",
        s.version
      );
      if (!confirmed) {
        appendTrace("confirm", "website_clear_audit_workspace", "Visitor cancelled irreversible reset.");
        return {
          ok: false,
          status: "cancelled",
          effect: "irreversible",
          reason: "Visitor cancelled workspace reset.",
        };
      }

      handlers.setState((prev) => ({
        ...prev,
        version: prev.version + 1,
        lastReport: null,
        lastPeerHop: null,
        trace: [],
      }));
      return {
        ok: true,
        status: "succeeded",
        effect: "irreversible",
        data: {
          cleared: true,
          version: handlers.getState().version,
        },
      };
    },
  };
}
