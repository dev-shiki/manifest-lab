import { expandReplacementStrings, parseHoconOrJson } from "./hoconParser";
import type {
  AgentManifest,
  AgentNetwork,
  ByokProfile,
  PeerConsentRequest,
  PeerHopResult,
} from "./types";

const BYOK_STORAGE_KEY = "manifest_lab_byok_profile_v1";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function loadByokProfile(storage: Pick<Storage, "getItem"> = localStorage): ByokProfile | null {
  try {
    const raw = storage.getItem(BYOK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ByokProfile>;
    if (
      typeof parsed.routerBaseUrl === "string" &&
      typeof parsed.modelName === "string" &&
      typeof parsed.apiKey === "string"
    ) {
      return {
        routerBaseUrl: parsed.routerBaseUrl,
        modelName: parsed.modelName,
        apiKey: parsed.apiKey,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveByokProfile(
  profile: ByokProfile,
  storage: Pick<Storage, "setItem"> = localStorage
): void {
  storage.setItem(BYOK_STORAGE_KEY, JSON.stringify(profile));
}

export function deleteByokProfile(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(BYOK_STORAGE_KEY);
}

/**
 * Filter private context (sly_data) per MVP Profile 0.2 Section 5:
 * deny-by-default unless a field is explicitly allowlisted without wildcards.
 * Never forwards credential-like keys.
 */
export function filterSlyDataForPeer(
  slyData: Record<string, unknown>,
  allowList: string[]
): {
  forwarded: Record<string, unknown>;
  forwardedKeys: string[];
  strippedKeys: string[];
} {
  const safeAllow = new Set(
    allowList.filter(
      (k) => k && k.trim() !== "*" && !/key|token|secret|password|auth/i.test(k)
    )
  );
  const forwarded: Record<string, unknown> = {};
  const forwardedKeys: string[] = [];
  const strippedKeys: string[] = [];

  for (const [k, v] of Object.entries(slyData)) {
    if (safeAllow.has(k)) {
      forwarded[k] = v;
      forwardedKeys.push(k);
    } else {
      strippedKeys.push(k);
    }
  }
  return { forwarded, forwardedKeys, strippedKeys };
}

export function resolvePeerManifestLocation(peerNetworkUrl: string): {
  siteBaseUrl: string;
  origin: string;
  protocol: string;
  hostname: string;
  networkName: string;
  manifestUrl: string;
} {
  const parsed = new URL(peerNetworkUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("Peer network URL must end with a network name path segment.");
  }
  const networkName = segments[segments.length - 1];
  const basePath = segments.slice(0, -1).join("/");
  const siteBaseUrl = basePath ? `${parsed.origin}/${basePath}` : parsed.origin;
  const manifestUrl = `${siteBaseUrl}/agent-manifest.json`;

  return {
    siteBaseUrl,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    networkName,
    manifestUrl,
  };
}

export function checkPeerOriginPolicy(
  callerManifest: AgentManifest,
  peerOrigin: string,
  protocol: string,
  hostname: string
): { allowed: boolean; reason?: string } {
  const isHttps = protocol === "https:";
  const isLoopback = protocol === "http:" && LOOPBACK_HOSTS.has(hostname);
  if (!isHttps && !isLoopback) {
    return {
      allowed: false,
      reason: `Refused non-HTTPS peer origin "${peerOrigin}" (only HTTPS or loopback HTTP allowed).`,
    };
  }

  const denied = new Set(callerManifest.peer_policy?.deny_origins ?? []);
  if (denied.has(peerOrigin)) {
    return {
      allowed: false,
      reason: `Peer origin "${peerOrigin}" is explicitly listed in peer_policy.deny_origins.`,
    };
  }

  const mode = callerManifest.peer_policy?.mode ?? "closed";
  if (mode !== "open") {
    const allowed = new Set(callerManifest.allowed_peers ?? []);
    if (!allowed.has(peerOrigin)) {
      return {
        allowed: false,
        reason: `Peer origin "${peerOrigin}" is not in allowed_peers while peer_policy.mode="${mode}".`,
      };
    }
  }

  return { allowed: true };
}

export interface ExecutePeerHopOptions {
  callerManifest: AgentManifest;
  callerNetwork: AgentNetwork;
  peerNetworkUrl: string;
  requestText: string;
  slyData: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  requestConsent: (consentReq: PeerConsentRequest) => Promise<boolean>;
  executePeerLocally?: (args: {
    peerManifest: AgentManifest;
    peerNetwork: AgentNetwork;
    frontMan: string;
    requestText: string;
    forwardedSlyData: Record<string, unknown>;
  }) => Promise<string>;
}

/**
 * Executes MVP Profile 0.2 Section 3.2 peer-site loading:
 * 1. Validates HTTPS/loopback + peer_policy + allowed_peers (fail-closed)
 * 2. Prompts visitor with destination origin and 140-char preview BEFORE network fetch
 * 3. Fetches peer agent-manifest.json and .network.json with ZERO caller credentials
 * 4. Matches exact requested network name (fail-closed if absent)
 * 5. Filters sly_data by explicit allowlist
 * 6. Runs peer network in caller's own runtime (caller router/key never sent to peer)
 */
export async function executePeerHop(opts: ExecutePeerHopOptions): Promise<PeerHopResult> {
  const fetcher = opts.fetchImpl ?? fetch;
  let resolved;
  try {
    resolved = resolvePeerManifestLocation(opts.peerNetworkUrl);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      peerOrigin: "(invalid-url)",
      networkName: "",
      forwardedSlyKeys: [],
      strippedSlyKeys: Object.keys(opts.slyData),
      byokHeaderSentToPeer: false,
      reason: err instanceof Error ? err.message : "Invalid peer URL.",
    };
  }

  const policyCheck = checkPeerOriginPolicy(
    opts.callerManifest,
    resolved.origin,
    resolved.protocol,
    resolved.hostname
  );
  if (!policyCheck.allowed) {
    return {
      ok: false,
      status: "denied",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: [],
      strippedSlyKeys: Object.keys(opts.slyData),
      byokHeaderSentToPeer: false,
      reason: policyCheck.reason,
    };
  }

  const allowList = opts.callerNetwork.private_context_allow ?? [];
  const slyFiltered = filterSlyDataForPeer(opts.slyData, allowList);
  const label =
    opts.callerNetwork.link_labels?.[opts.peerNetworkUrl] ??
    opts.callerNetwork.link_labels?.[resolved.networkName] ??
    resolved.networkName;

  const approved = await opts.requestConsent({
    peerUrl: opts.peerNetworkUrl,
    peerOrigin: resolved.origin,
    networkName: resolved.networkName,
    displayLabel: label,
    requestPreview140: opts.requestText.slice(0, 140),
    allowedSlyFields: slyFiltered.forwardedKeys,
  });

  if (!approved) {
    return {
      ok: false,
      status: "cancelled",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: [],
      strippedSlyKeys: Object.keys(opts.slyData),
      byokHeaderSentToPeer: false,
      reason: "The user declined contact with the peer origin.",
    };
  }

  // Fetch peer manifest WITHOUT credentials or Authorization header
  let peerManifest: AgentManifest;
  try {
    const mResp = await fetcher(resolved.manifestUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    if (!mResp.ok) {
      return {
        ok: false,
        status: "error",
        peerOrigin: resolved.origin,
        networkName: resolved.networkName,
        forwardedSlyKeys: slyFiltered.forwardedKeys,
        strippedSlyKeys: slyFiltered.strippedKeys,
        byokHeaderSentToPeer: false,
        reason: `Peer manifest fetch failed with HTTP ${mResp.status}.`,
      };
    }
    peerManifest = (await mResp.json()) as AgentManifest;
  } catch (err) {
    return {
      ok: false,
      status: "error",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: slyFiltered.forwardedKeys,
      strippedSlyKeys: slyFiltered.strippedKeys,
      byokHeaderSentToPeer: false,
      reason: err instanceof Error ? err.message : "Peer manifest fetch failed.",
    };
  }

  const exactEntry = (peerManifest.networks ?? []).find(
    (n) => n.name === resolved.networkName
  );
  if (!exactEntry) {
    return {
      ok: false,
      status: "error",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: slyFiltered.forwardedKeys,
      strippedSlyKeys: slyFiltered.strippedKeys,
      byokHeaderSentToPeer: false,
      reason: `Peer manifest at ${resolved.manifestUrl} does not publish network "${resolved.networkName}".`,
    };
  }

  let networkDefUrlObj: URL;
  try {
    networkDefUrlObj = new URL(exactEntry.hocon, `${resolved.siteBaseUrl}/`);
  } catch {
    return {
      ok: false,
      status: "error",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: [],
      strippedSlyKeys: Object.keys(opts.slyData),
      byokHeaderSentToPeer: false,
      reason: `Peer manifest entry "${resolved.networkName}" declared an invalid hocon URL.`,
    };
  }
  if (networkDefUrlObj.origin !== resolved.origin) {
    return {
      ok: false,
      status: "denied",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: [],
      strippedSlyKeys: Object.keys(opts.slyData),
      byokHeaderSentToPeer: false,
      reason: `Refused cross-origin network definition URL "${networkDefUrlObj.toString()}" outside consented peer origin "${resolved.origin}".`,
    };
  }
  const networkDefUrl = networkDefUrlObj.toString();
  let peerNetwork: AgentNetwork;
  try {
    const nResp = await fetcher(networkDefUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    if (!nResp.ok) {
      return {
        ok: false,
        status: "error",
        peerOrigin: resolved.origin,
        networkName: resolved.networkName,
        forwardedSlyKeys: slyFiltered.forwardedKeys,
        strippedSlyKeys: slyFiltered.strippedKeys,
        byokHeaderSentToPeer: false,
        reason: `Peer network definition fetch failed with HTTP ${nResp.status}.`,
      };
    }
    const rawNetworkText = await nResp.text();
    peerNetwork = expandReplacementStrings(parseHoconOrJson(rawNetworkText) as AgentNetwork);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: slyFiltered.forwardedKeys,
      strippedSlyKeys: slyFiltered.strippedKeys,
      byokHeaderSentToPeer: false,
      reason: err instanceof Error ? err.message : "Peer network definition fetch failed.",
    };
  }

  const frontAgent = (peerNetwork.tools ?? []).find(
    (t) => t.name === exactEntry.front_man
  );
  if (!frontAgent) {
    return {
      ok: false,
      status: "error",
      peerOrigin: resolved.origin,
      networkName: resolved.networkName,
      forwardedSlyKeys: slyFiltered.forwardedKeys,
      strippedSlyKeys: slyFiltered.strippedKeys,
      byokHeaderSentToPeer: false,
      reason: `Peer front_man "${exactEntry.front_man}" missing in peer network definition.`,
    };
  }

  const reply = opts.executePeerLocally
    ? await opts.executePeerLocally({
        peerManifest,
        peerNetwork,
        frontMan: exactEntry.front_man,
        requestText: opts.requestText,
        forwardedSlyData: slyFiltered.forwarded,
      })
    : `Loaded peer network "${resolved.networkName}" (front agent: ${exactEntry.front_man}) locally. ${peerNetwork.metadata?.description ?? ""}`.trim();

  return {
    ok: true,
    status: "succeeded",
    peerOrigin: resolved.origin,
    networkName: resolved.networkName,
    reply,
    forwardedSlyKeys: slyFiltered.forwardedKeys,
    strippedSlyKeys: slyFiltered.strippedKeys,
    byokHeaderSentToPeer: false,
  };
}
