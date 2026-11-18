import type { ActionInvocationResult, AuditReport, PeerHopResult } from "../core/types";
import type { createSiteActions } from "./siteActions";

export type SiteActionsApi = ReturnType<typeof createSiteActions>;

export interface AgentTurnOutput {
  routerLabel: string;
  agentPath: string[];
  toolCalls: Array<{ tool: string; result: ActionInvocationResult }>;
  replyText: string;
}

/**
 * Zero-cost deterministic local router that executes the manifest_lab
 * multi-agent flow directly against registered website_* actions without
 * calling any external paid LLM API.
 */
export async function runDeterministicAgentTurn(
  prompt: string,
  actions: SiteActionsApi
): Promise<AgentTurnOutput> {
  const lower = prompt.toLowerCase();
  const agentPath = ["manifest_coordinator"];
  const toolCalls: Array<{ tool: string; result: ActionInvocationResult }> = [];

  if (/\b(clear|reset)\b/.test(lower)) {
    const stateRes = actions.get_workbench_state();
    toolCalls.push({ tool: "website_get_workbench_state", result: stateRes });
    const currentVersion = (stateRes.data as { version: number })?.version ?? 1;
    const clearRes = await actions.clear_audit_workspace({ expected_version: currentVersion });
    toolCalls.push({ tool: "website_clear_audit_workspace", result: clearRes });
    return {
      routerLabel: "Offline Deterministic Router ($0 local)",
      agentPath,
      toolCalls,
      replyText: clearRes.ok
        ? `Workspace cleared (state version is now ${(clearRes.data as { version: number }).version}).`
        : clearRes.reason ?? "Workspace reset was cancelled or refused.",
    };
  }

  if (/\b(leaky|sly_data|secret|broken)\b/.test(lower) && /\b(load|preset|switch|test)\b/.test(lower)) {
    const loadRes = actions.load_bundle_preset({ preset: "leaky_sly_data" });
    toolCalls.push({ tool: "website_load_bundle_preset", result: loadRes });
    agentPath.push("boundary_verifier");
    const auditRes = actions.run_conformance_audit();
    toolCalls.push({ tool: "website_run_conformance_audit", result: auditRes });
    const report = auditRes.data as AuditReport | undefined;
    if (!auditRes.ok || !report) {
      return {
        routerLabel: "Offline Deterministic Router ($0 local)",
        agentPath,
        toolCalls,
        replyText: auditRes.reason ?? "Audit failed.",
      };
    }
    const failing = report.findings
      .filter((f) => f.severity === "fail")
      .map((f) => `${f.ruleId}: ${f.message}`);
    return {
      routerLabel: "Offline Deterministic Router ($0 local)",
      agentPath,
      toolCalls,
      replyText: `Loaded leaky_sly_data preset and delegated boundary inspection to boundary_verifier. Result: ${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail. Failures: ${failing.join(" | ")}`,
    };
  }

  if (/\b(unsafe|insecure)\b/.test(lower) && /\b(load|preset|switch|test)\b/.test(lower)) {
    const loadRes = actions.load_bundle_preset({ preset: "unsafe_peer" });
    toolCalls.push({ tool: "website_load_bundle_preset", result: loadRes });
    agentPath.push("boundary_verifier");
    const auditRes = actions.run_conformance_audit();
    toolCalls.push({ tool: "website_run_conformance_audit", result: auditRes });
    const report = auditRes.data as AuditReport | undefined;
    const failing = (report?.findings ?? [])
      .filter((f) => f.severity === "fail")
      .map((f) => `${f.ruleId}: ${f.message}`);
    return {
      routerLabel: "Offline Deterministic Router ($0 local)",
      agentPath,
      toolCalls,
      replyText: report
        ? `Loaded unsafe_peer preset. Result: ${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail. Failures: ${failing.join(" | ")}`
        : auditRes.reason ?? "Audit failed.",
    };
  }

  if (/\b(peer|hop|civic|directory|consent|linked)\b/.test(lower)) {
    agentPath.push("boundary_verifier");
    const hopRes = await actions.simulate_peer_hop({
      request: prompt.slice(0, 140),
    });
    toolCalls.push({ tool: "website_simulate_peer_hop", result: hopRes });
    const hop = hopRes.data as PeerHopResult | undefined;
    if (hopRes.ok && hop) {
      return {
        routerLabel: "Offline Deterministic Router ($0 local)",
        agentPath,
        toolCalls,
        replyText: `${hop.reply ?? "Peer hop completed."} Stripped sly_data keys: ${hop.strippedSlyKeys.join(", ") || "none"}. BYOK key sent to peer: ${String(hop.byokHeaderSentToPeer)}.`,
      };
    }
    return {
      routerLabel: "Offline Deterministic Router ($0 local)",
      agentPath,
      toolCalls,
      replyText: `Peer hop ${hopRes.status}: ${hopRes.reason ?? "Blocked by policy or cancelled."}`,
    };
  }

  // Default: inspect state and run conformance audit on active bundle
  const stateRes = actions.get_workbench_state();
  toolCalls.push({ tool: "website_get_workbench_state", result: stateRes });
  agentPath.push("boundary_verifier");
  const auditRes = actions.run_conformance_audit();
  toolCalls.push({ tool: "website_run_conformance_audit", result: auditRes });

  const report = auditRes.data as AuditReport | undefined;
  if (!auditRes.ok || !report) {
    return {
      routerLabel: "Offline Deterministic Router ($0 local)",
      agentPath,
      toolCalls,
      replyText: auditRes.reason ?? "Could not parse the active bundle.",
    };
  }

  const issueLines = report.findings
    .filter((f) => f.severity !== "pass")
    .map((f) => `[${f.severity.toUpperCase()}] ${f.ruleId}: ${f.message}`);

  return {
    routerLabel: "Offline Deterministic Router ($0 local)",
    agentPath,
    toolCalls,
    replyText:
      issueLines.length === 0
        ? `Conformant (${report.counts.pass}/${report.findings.length} rules passed, 0 warnings, 0 failures) for "${report.bundleLabel}".`
        : `Non-conformant or warnings for "${report.bundleLabel}" (${report.counts.pass} pass, ${report.counts.warn} warn, ${report.counts.fail} fail): ${issueLines.join(" | ")}`,
  };
}
