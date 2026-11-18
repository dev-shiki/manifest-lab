export type AuditSeverity = "pass" | "warn" | "fail";

export type ActionEffect = "read" | "write" | "irreversible";

export interface ManifestNetworkEntry {
  name: string;
  front_man: string;
  hocon: string;
  description?: string;
  tags?: string[];
  sample_queries?: string[];
}

export interface PeerPolicy {
  mode?: "closed" | "open" | string;
  deny_origins?: string[];
  note?: string;
}

export interface ManifestActionsConfig {
  version: number;
  module: string;
  bridge?: string;
  agentTools: string[];
  irreversibleTools?: string[];
}

export interface AgentManifest {
  brand?: string;
  networks: ManifestNetworkEntry[];
  llm_router?: {
    base_url?: string;
    mock?: boolean;
    byok_router?: string;
    api_key?: string;
  };
  allowed_peers?: string[];
  peer_policy?: PeerPolicy;
  agent_mcp?: {
    protocol?: string;
    network?: string;
    front_man?: string;
    available?: boolean;
    reason?: string;
  };
  theme?: {
    primary?: string;
  };
  linking?: {
    protocol?: string;
    exports?: Array<{
      network: string;
      front_man: string;
      aliases?: string[];
      url: string;
    }>;
    imports?: unknown[];
    link_updates?: {
      mode?: string;
    };
  };
  deployment?: {
    mode?: string;
    self_contained_runtime?: boolean;
    browser_mock?: boolean;
    direct_byok?: boolean;
    direct_mcp_requires_cors?: boolean;
    public_mcp_facade?: boolean;
  };
  actions?: ManifestActionsConfig;
}

export interface McpToolDescriptor {
  url: string;
  tools?: string[];
}

export type AgentToolRef = string | McpToolDescriptor;

export interface AgentDefinition {
  name: string;
  function?: {
    description?: string;
    parameters?: {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
  instructions?: string;
  tools?: AgentToolRef[];
  private_context_allow?: string[];
}

export interface AgentNetwork {
  metadata?: {
    description?: string;
    sample_queries?: string[];
  };
  llm_config?: {
    model_name?: string;
  };
  max_steps?: number;
  max_execution_seconds?: number;
  link_labels?: Record<string, string>;
  commondefs?: {
    replacement_strings?: Record<string, string>;
  };
  private_context_allow?: string[];
  tools: AgentDefinition[];
}

export interface LinksMap {
  version: number;
  networks: Record<string, Record<string, string>>;
}

export interface AgentMcpDescriptor {
  protocol?: string;
  network?: string;
  front_man?: string;
  available?: boolean;
  reason?: string;
}

export interface BundleInput {
  label: string;
  manifest: AgentManifest;
  network: AgentNetwork;
  links?: LinksMap;
  agentMcp?: AgentMcpDescriptor;
  rawSourceText?: string;
}

export interface AuditFinding {
  ruleId: string;
  specSection: string;
  title: string;
  severity: AuditSeverity;
  path: string;
  message: string;
  remediation: string;
}

export interface AuditReport {
  bundleLabel: string;
  checkedAtIso: string;
  counts: {
    pass: number;
    warn: number;
    fail: number;
  };
  conformant: boolean;
  findings: AuditFinding[];
  discoveredPeerUrls: string[];
  discoveredMcpUrls: string[];
}

export interface ByokProfile {
  routerBaseUrl: string;
  modelName: string;
  apiKey: string;
}

export type RouterMode = "deterministic" | "byok";

export interface PeerConsentRequest {
  peerUrl: string;
  peerOrigin: string;
  networkName: string;
  displayLabel: string;
  requestPreview140: string;
  allowedSlyFields: string[];
}

export interface PeerHopResult {
  ok: boolean;
  status: "succeeded" | "cancelled" | "denied" | "error";
  peerOrigin: string;
  networkName: string;
  reply?: string;
  forwardedSlyKeys: string[];
  strippedSlyKeys: string[];
  byokHeaderSentToPeer: boolean;
  reason?: string;
}

export interface ExecutionTraceEntry {
  id: string;
  timestampIso: string;
  kind: "agent" | "tool" | "peer" | "consent" | "confirm" | "error";
  actor: string;
  summary: string;
  origin?: string;
}

export interface ActionInvocationResult {
  ok: boolean;
  status: "succeeded" | "cancelled" | "unknown" | "refused";
  effect: ActionEffect;
  data?: unknown;
  reason?: string;
}
