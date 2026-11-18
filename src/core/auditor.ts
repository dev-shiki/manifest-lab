import type {
  AgentDefinition,
  AgentManifest,
  AgentNetwork,
  AuditFinding,
  AuditReport,
  BundleInput,
} from "./types";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{12,}/,
  /Bearer\s+[a-zA-Z0-9._-]{10,}/i,
  /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9._-]{10,}/i,
];
const UNSAFE_INSTRUCTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /exfiltrate/i,
  /override\s+(the\s+)?(caller|active)\s+router/i,
  /send\s+(the\s+)?(user'?s?\s+)?(api\s+key|credential|token|secret)/i,
  /bypass\s+(user\s+)?consent/i,
];
const LOCAL_PATH_PATTERN = /(\$\{[A-Z0-9_]+\}|file:\/\/|\/Users\/|[A-Z]:\\\\)/;

function isPeerUrlString(ref: string): boolean {
  return ref.startsWith("http://") || ref.startsWith("https://");
}

function parseUrlOrigin(rawUrl: string): { origin: string; protocol: string; hostname: string } | null {
  try {
    const parsed = new URL(rawUrl);
    return {
      origin: parsed.origin,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
    };
  } catch {
    return null;
  }
}

function collectExternalRefs(network: AgentNetwork): {
  peerUrls: string[];
  mcpUrls: string[];
} {
  const peerSet = new Set<string>();
  const mcpSet = new Set<string>();
  const tools = Array.isArray(network.tools) ? network.tools : [];

  for (const agent of tools) {
    const refs = Array.isArray(agent.tools) ? agent.tools : [];
    for (const ref of refs) {
      if (typeof ref === "string" && isPeerUrlString(ref)) {
        peerSet.add(ref);
      } else if (ref && typeof ref === "object" && typeof ref.url === "string") {
        mcpSet.add(ref.url);
      }
    }
  }
  return {
    peerUrls: Array.from(peerSet),
    mcpUrls: Array.from(mcpSet),
  };
}

function isAllowedPeerOrigin(manifest: AgentManifest, origin: string): boolean {
  const policyMode = manifest.peer_policy?.mode ?? "closed";
  const denied = new Set(manifest.peer_policy?.deny_origins ?? []);
  if (denied.has(origin)) {
    return false;
  }
  if (policyMode === "open") {
    return true;
  }
  const allowed = new Set(manifest.allowed_peers ?? []);
  return allowed.has(origin);
}

export function auditAgenticBundle(input: BundleInput): AuditReport {
  const findings: AuditFinding[] = [];
  const { manifest, network, links, agentMcp } = input;
  const agents: AgentDefinition[] = Array.isArray(network?.tools) ? network.tools : [];
  const { peerUrls, mcpUrls } = collectExternalRefs(network ?? { tools: [] });

  // 1. MVS-2.1-MANIFEST: Non-empty manifest networks with name, front_man, hocon
  const manifestNetworks = Array.isArray(manifest?.networks) ? manifest.networks : [];
  const primaryNet = manifestNetworks[0];
  const manifestValid =
    manifestNetworks.length > 0 &&
    manifestNetworks.every(
      (n) =>
        typeof n.name === "string" &&
        n.name.trim().length > 0 &&
        typeof n.front_man === "string" &&
        n.front_man.trim().length > 0 &&
        typeof n.hocon === "string" &&
        n.hocon.trim().length > 0
    );

  findings.push({
    ruleId: "MVS-2.1-MANIFEST",
    specSection: "Section 2.1 / 3.3",
    title: "Site manifest declares valid networks",
    severity: manifestValid ? "pass" : "fail",
    path: "agent-manifest.json#networks",
    message: manifestValid
      ? `Manifest publishes ${manifestNetworks.length} network entry with name, front_man, and hocon.`
      : "Manifest must define at least one network with non-empty name, front_man, and hocon.",
    remediation: "Add networks[0] with name, front_man, and hocon pointing to the resolved .network.json file.",
  });

  // 2. MVS-2.1-FRONTMAN: Declared front_man resolves to an agent in tools[]
  const agentNames = new Set(agents.map((a) => a.name).filter(Boolean));
  const frontManName = primaryNet?.front_man ?? "";
  const frontManExists = Boolean(frontManName) && agentNames.has(frontManName);
  findings.push({
    ruleId: "MVS-2.1-FRONTMAN",
    specSection: "Section 2.1 / 3.1",
    title: "Front agent exists in network definition",
    severity: frontManExists ? "pass" : "fail",
    path: "agent-manifest.json#networks[0].front_man",
    message: frontManExists
      ? `Front agent "${frontManName}" exists in network.tools.`
      : `Declared front_man "${frontManName || "(missing)"}" was not found in network.tools.`,
    remediation: "Ensure front_man matches an exact agent name in network.tools.",
  });

  // 3. MVS-2.1-UNIQUE-NAMES: Unique internal agent names
  const seenNames = new Set<string>();
  const duplicates: string[] = [];
  for (const agent of agents) {
    if (!agent.name) continue;
    if (seenNames.has(agent.name)) {
      duplicates.push(agent.name);
    }
    seenNames.add(agent.name);
  }
  const uniqueOk = agents.length > 0 && duplicates.length === 0;
  findings.push({
    ruleId: "MVS-2.1-UNIQUE-NAMES",
    specSection: "Section 2.1",
    title: "Agent names are unique within network",
    severity: uniqueOk ? "pass" : "fail",
    path: "network.tools[].name",
    message: uniqueOk
      ? `All ${agents.length} agent names are unique.`
      : agents.length === 0
      ? "Network defines zero agents in tools[]."
      : `Duplicate agent names found: ${duplicates.join(", ")}.`,
    remediation: "Give every agent in network.tools a unique identifier.",
  });

  // 4. MVS-2.1-AGENT-SCHEMA: function.description & JSON Schema object parameters
  const schemaMissing: string[] = [];
  for (const agent of agents) {
    const hasDesc =
      typeof agent.function?.description === "string" &&
      agent.function.description.trim().length > 0;
    const paramType = agent.function?.parameters?.type;
    const hasParams = paramType === "object";
    if (!hasDesc || !hasParams) {
      schemaMissing.push(agent.name || "(unnamed)");
    }
  }
  findings.push({
    ruleId: "MVS-2.1-AGENT-SCHEMA",
    specSection: "Section 2.1",
    title: "Agents declare callable descriptions and JSON Schema inputs",
    severity: agents.length > 0 && schemaMissing.length === 0 ? "pass" : "fail",
    path: "network.tools[].function",
    message:
      agents.length > 0 && schemaMissing.length === 0
        ? "Every agent exposes function.description and object JSON Schema parameters."
        : `Agents missing description or object parameters: ${schemaMissing.join(", ") || "none"}.`,
    remediation: "Define function.description and function.parameters.type = 'object' for every agent.",
  });

  // 5. MVS-2.1-LOCAL-REFS: Symbolic or local tool references resolve
  const linkSlotMap = links?.networks?.[primaryNet?.name ?? ""] ?? {};
  const danglingRefs: string[] = [];
  for (const agent of agents) {
    for (const ref of agent.tools ?? []) {
      if (typeof ref === "string") {
        if (isPeerUrlString(ref)) continue;
        if (ref.startsWith("website_")) continue;
        if (agentNames.has(ref)) continue;
        if (Object.prototype.hasOwnProperty.call(linkSlotMap, ref)) continue;
        danglingRefs.push(`${agent.name}->${ref}`);
      }
    }
  }
  findings.push({
    ruleId: "MVS-2.1-LOCAL-REFS",
    specSection: "Section 3.1 / 3.3",
    title: "All local agent and link references resolve",
    severity: danglingRefs.length === 0 ? "pass" : "fail",
    path: "network.tools[].tools",
    message:
      danglingRefs.length === 0
        ? "Every internal tool reference resolves to a local agent or links.json binding."
        : `Unresolved tool references: ${danglingRefs.join(", ")}.`,
    remediation: "Add the missing agent to network.tools or bind symbolic peer names in links.json.",
  });

  // 6. MVS-2.1-REACHABILITY: BFS from front_man
  const reachable = new Set<string>();
  if (frontManExists) {
    const queue = [frontManName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      const def = agents.find((a) => a.name === current);
      for (const ref of def?.tools ?? []) {
        if (typeof ref === "string" && agentNames.has(ref) && !reachable.has(ref)) {
          queue.push(ref);
        }
      }
    }
  }
  const unreachable = agents.map((a) => a.name).filter((name) => !reachable.has(name));
  findings.push({
    ruleId: "MVS-2.1-REACHABILITY",
    specSection: "Section 2.1",
    title: "All declared agents are reachable from front_man",
    severity: unreachable.length === 0 && frontManExists ? "pass" : "warn",
    path: "network.tools",
    message:
      unreachable.length === 0 && frontManExists
        ? `All ${agents.length} agents are reachable from "${frontManName}".`
        : `Unreachable agents from front_man: ${unreachable.join(", ") || "(no front_man)"}.`,
    remediation: "Link helper agents from front_man.tools or remove unused agent definitions.",
  });

  // 7. MVS-2.2-DATA-ONLY: Resolved data-only network (no unexpanded placeholders or local paths)
  const serializedNetwork = JSON.stringify(network ?? {});
  const unexpandedMatches = serializedNetwork.match(/\{[a-zA-Z0-9_]+\}/g) ?? [];
  const hasLocalPath = LOCAL_PATH_PATTERN.test(serializedNetwork);
  const dataOnlyOk = unexpandedMatches.length === 0 && !hasLocalPath;
  findings.push({
    ruleId: "MVS-2.2-DATA-ONLY",
    specSection: "Section 2.2",
    title: "Published network is resolved data-only JSON",
    severity: dataOnlyOk ? "pass" : "fail",
    path: "network.json",
    message: dataOnlyOk
      ? "No unexpanded placeholders, environment substitutions, or local filesystem paths detected."
      : `Found unexpanded tokens (${unexpandedMatches.slice(0, 3).join(", ") || "none"}) or local filesystem paths.`,
    remediation: "Expand all commondefs.replacement_strings and remove local filesystem or env references before publishing.",
  });

  // 8. MVS-3.1-BOUNDED-EXEC: Finite max_steps / max_execution_seconds
  const maxSteps = network?.max_steps;
  const maxSeconds = network?.max_execution_seconds;
  const hasValidSteps = typeof maxSteps === "number" && maxSteps > 0 && maxSteps <= 30;
  const hasValidSeconds =
    typeof maxSeconds === "number" && maxSeconds > 0 && maxSeconds <= 600;
  const boundedOk = hasValidSteps || hasValidSeconds;
  findings.push({
    ruleId: "MVS-3.1-BOUNDED-EXEC",
    specSection: "Section 3.1",
    title: "Execution budgets are explicitly bounded",
    severity: boundedOk ? "pass" : "warn",
    path: "network.max_steps / max_execution_seconds",
    message: boundedOk
      ? `Bounded execution configured (max_steps=${maxSteps ?? "unset"}, max_execution_seconds=${maxSeconds ?? "unset"}).`
      : "Neither max_steps (<= 30) nor max_execution_seconds (<= 600) is set.",
    remediation: "Set max_steps (e.g. 12) and max_execution_seconds (e.g. 180) in the published network.",
  });

  // 9. MVS-3.2-PEER-HTTPS: Peer URLs must use HTTPS (or loopback HTTP for local dev)
  const allExternalUrls = [
    ...peerUrls,
    ...Object.values(linkSlotMap).filter((v) => typeof v === "string" && isPeerUrlString(v)),
  ];
  const nonHttpsPeers: string[] = [];
  for (const url of allExternalUrls) {
    const parsed = parseUrlOrigin(url);
    if (!parsed) {
      nonHttpsPeers.push(url);
      continue;
    }
    const isHttps = parsed.protocol === "https:";
    const isLoopback = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
    if (!isHttps && !isLoopback) {
      nonHttpsPeers.push(url);
    }
  }
  findings.push({
    ruleId: "MVS-3.2-PEER-HTTPS",
    specSection: "Section 3.2",
    title: "External peer URLs require HTTPS (except loopback dev)",
    severity: nonHttpsPeers.length === 0 ? "pass" : "fail",
    path: "network.tools[] / links.json",
    message:
      nonHttpsPeers.length === 0
        ? allExternalUrls.length === 0
          ? "No remote peer URLs declared."
          : `All ${allExternalUrls.length} peer URL(s) use HTTPS or loopback HTTP.`
        : `Insecure non-loopback HTTP or invalid peer URLs: ${nonHttpsPeers.join(", ")}.`,
    remediation: "Serve production peer networks over HTTPS.",
  });

  // 10. MVS-3.2-PEER-POLICY: Peer URLs permitted by allowed_peers / peer_policy
  const blockedPeers: string[] = [];
  for (const url of allExternalUrls) {
    const parsed = parseUrlOrigin(url);
    if (!parsed || !isAllowedPeerOrigin(manifest, parsed.origin)) {
      blockedPeers.push(url);
    }
  }
  findings.push({
    ruleId: "MVS-3.2-PEER-POLICY",
    specSection: "Section 3.2 / 3.3",
    title: "Peer policy and allowed_peers match declared peer URLs",
    severity: blockedPeers.length === 0 ? "pass" : "fail",
    path: "agent-manifest.json#allowed_peers",
    message:
      blockedPeers.length === 0
        ? "All referenced peer origins are permitted by peer_policy and allowed_peers."
        : `Peer URLs blocked by manifest peer_policy: ${blockedPeers.join(", ")}.`,
    remediation: "Add approved peer origins to allowed_peers or keep peer_policy.mode='closed' for local-only sites.",
  });

  // 11. MVS-3.3-LINKS-MAP: links.json structure
  const linksValid =
    Boolean(links) &&
    links?.version === 1 &&
    typeof links.networks === "object" &&
    links.networks !== null &&
    Boolean(primaryNet?.name && Object.prototype.hasOwnProperty.call(links.networks, primaryNet.name));
  findings.push({
    ruleId: "MVS-3.3-LINKS-MAP",
    specSection: "Section 3.3",
    title: "Peer-network links.json matches published network",
    severity: linksValid ? "pass" : "warn",
    path: "links.json#networks",
    message: linksValid
      ? `links.json version 1 maps network "${primaryNet?.name}".`
      : "links.json is missing, not version 1, or omits the primary network key.",
    remediation: "Publish links.json with version: 1 and an entry under networks.<network_name>.",
  });

  // 12. MVS-4.0-BYOK-HYGIENE: No embedded secrets or credentials in public artifacts
  const combinedPublic = JSON.stringify({ manifest, network, links, agentMcp });
  const secretHit =
    Boolean(manifest?.llm_router?.api_key) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(combinedPublic));
  findings.push({
    ruleId: "MVS-4.0-BYOK-HYGIENE",
    specSection: "Section 4",
    title: "Public artifacts contain zero embedded API keys",
    severity: !secretHit ? "pass" : "fail",
    path: "agent-manifest.json / network.json",
    message: !secretHit
      ? "No hardcoded credentials or bearer tokens found in manifest, network, or links."
      : "Credential or API key literal detected inside published static artifacts.",
    remediation: "Remove all keys from public JSON files; collect visitor BYOK credentials only in browser localStorage.",
  });

  // 13. MVS-5.0-SLY-DATA-DENY: Private context (sly_data) must be deny-by-default (no wildcard `*`)
  const allowLists: string[] = [
    ...(network?.private_context_allow ?? []),
    ...agents.flatMap((a) => a.private_context_allow ?? []),
  ];
  const hasWildcardSly = allowLists.some((field) => field.trim() === "*" || field.includes("api_key"));
  findings.push({
    ruleId: "MVS-5.0-SLY-DATA-DENY",
    specSection: "Section 2.1 / 5",
    title: "Private context (sly_data) enforces deny-by-default rules",
    severity: !hasWildcardSly ? "pass" : "fail",
    path: "network.private_context_allow",
    message: !hasWildcardSly
      ? allowLists.length === 0
        ? "No cross-site sly_data forwarding allowlisted (strict deny-by-default)."
        : `Explicit sly_data allowlist declared without wildcards: ${allowLists.join(", ")}.`
      : `Unsafe sly_data forwarding rule detected (${allowLists.join(", ")}).`,
    remediation: "Never use '*' or forward credential fields in private_context_allow.",
  });

  // 14. MVS-5.0-UNTRUSTED-INSTRUCTIONS: Prompt override / exfiltration scan
  const flaggedAgents: string[] = [];
  for (const agent of agents) {
    const instr = agent.instructions ?? "";
    if (UNSAFE_INSTRUCTION_PATTERNS.some((pat) => pat.test(instr))) {
      flaggedAgents.push(agent.name);
    }
  }
  findings.push({
    ruleId: "MVS-5.0-UNTRUSTED-INSTRUCTIONS",
    specSection: "Section 5",
    title: "Instructions free of router-override or exfiltration directives",
    severity: flaggedAgents.length === 0 ? "pass" : "fail",
    path: "network.tools[].instructions",
    message:
      flaggedAgents.length === 0
        ? "No instruction-override, consent-bypass, or credential-exfiltration directives detected."
        : `Suspicious instruction directives in agents: ${flaggedAgents.join(", ")}.`,
    remediation: "Remove directives attempting to override caller router policies, bypass consent, or exfiltrate keys.",
  });

  // 15. MVS-5.0-ACTION-SAFETY: Actions metadata pairs module & irreversible tools
  const actionsCfg = manifest?.actions;
  let actionsSeverity: "pass" | "warn" | "fail" = "pass";
  let actionsMessage = "No browser site actions declared.";
  if (actionsCfg) {
    const hasModule = typeof actionsCfg.module === "string" && actionsCfg.module.trim().length > 0;
    const hasTools = Array.isArray(actionsCfg.agentTools) && actionsCfg.agentTools.length > 0;
    const hasBridge = typeof actionsCfg.bridge === "string" && actionsCfg.bridge.trim().length > 0;
    if (!hasModule || !hasTools) {
      actionsSeverity = "fail";
      actionsMessage = "actions block must declare non-empty module and agentTools.";
    } else if (!hasBridge) {
      actionsSeverity = "warn";
      actionsMessage = "actions block works locally; add actions.bridge for cross-site bridge discovery.";
    } else {
      actionsMessage = `Site actions module (${actionsCfg.module}) declares ${actionsCfg.agentTools.length} tools and bridge.`;
    }
  }
  findings.push({
    ruleId: "MVS-5.0-ACTION-SAFETY",
    specSection: "Section 3.1 / 5",
    title: "Site actions declare module, tools, and bridge safely",
    severity: actionsSeverity,
    path: "agent-manifest.json#actions",
    message: actionsMessage,
    remediation: "Specify actions.module, actions.agentTools, and actions.bridge ('./bridge/action-bridge.html').",
  });

  // 16. MVS-3.4-MCP-CORS-HONESTY: Static deployments accurately report public MCP availability
  const isStatic = manifest?.deployment?.mode === "static";
  const mcpClaimedAvailable = agentMcp?.available === true || manifest?.agent_mcp?.available === true;
  const mcpHonest = !(isStatic && mcpClaimedAvailable && mcpUrls.length === 0);
  findings.push({
    ruleId: "MVS-3.4-MCP-CORS-HONESTY",
    specSection: "Section 3.3 / 3.4",
    title: "Static bundle accurately reports MCP facade availability",
    severity: mcpHonest ? "pass" : "fail",
    path: "agent-mcp.json#available",
    message: mcpHonest
      ? "Public MCP availability metadata matches deployment mode."
      : "Static deployment claims public MCP facade is available without a hosted MCP endpoint.",
    remediation: "Set agent_mcp.available to false in static bundles unless an application host serves MCP.",
  });

  const counts = {
    pass: findings.filter((f) => f.severity === "pass").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    fail: findings.filter((f) => f.severity === "fail").length,
  };

  return {
    bundleLabel: input.label,
    checkedAtIso: new Date().toISOString(),
    counts,
    conformant: counts.fail === 0,
    findings,
    discoveredPeerUrls: allExternalUrls,
    discoveredMcpUrls: mcpUrls,
  };
}
