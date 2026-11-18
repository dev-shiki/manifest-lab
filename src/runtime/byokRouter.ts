import type { AgentNetwork, ByokProfile } from "../core/types";
import type { AgentTurnOutput, SiteActionsApi } from "./deterministicRouter";

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "website_get_workbench_state",
      description: "Read current bundle preset, state version, and last audit summary.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "website_load_bundle_preset",
      description: "Load one of the built-in bundle presets into the workbench editor.",
      parameters: {
        type: "object",
        properties: {
          preset: {
            type: "string",
            enum: ["conforming", "leaky_sly_data", "unsafe_peer"],
          },
        },
        required: ["preset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_run_conformance_audit",
      description: "Run all 16 Open Agentic Web MVP 0.2 conformance rules on the active bundle.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "website_simulate_peer_hop",
      description: "Simulate a cross-origin peer network hop with consent and sly_data isolation.",
      parameters: {
        type: "object",
        properties: {
          peerUrl: { type: "string" },
          request: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "website_clear_audit_workspace",
      description: "Irreversible reset of audit report and trace. Requires expected_version from get_workbench_state.",
      parameters: {
        type: "object",
        properties: {
          expected_version: { type: "number" },
        },
        required: ["expected_version"],
      },
    },
  },
];

async function dispatchSiteTool(
  name: string,
  rawArgs: string,
  actions: SiteActionsApi
) {
  let parsed: Record<string, unknown> = {};
  if (rawArgs.trim()) {
    try {
      parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        status: "refused" as const,
        effect: "read" as const,
        reason: "Invalid JSON arguments passed to tool.",
      };
    }
  }
  switch (name) {
    case "website_get_workbench_state":
      return actions.get_workbench_state();
    case "website_load_bundle_preset":
      return actions.load_bundle_preset(parsed as { preset?: string });
    case "website_run_conformance_audit":
      return actions.run_conformance_audit();
    case "website_simulate_peer_hop":
      return actions.simulate_peer_hop(parsed as { peerUrl?: string; request?: string });
    case "website_clear_audit_workspace":
      return actions.clear_audit_workspace(parsed as { expected_version?: number });
    default:
      return {
        ok: false,
        status: "refused" as const,
        effect: "read" as const,
        reason: `Unknown tool: ${name}`,
      };
  }
}

/**
 * Executes a real OpenAI-compatible BYOK turn against the visitor's selected
 * router (e.g. Otari, OpenAI, OpenRouter, or local Ollama). The API key is sent
 * ONLY to `profile.routerBaseUrl` and never included in URLs, traces, or peer requests.
 */
export async function runByokAgentTurn(
  prompt: string,
  profile: ByokProfile,
  network: AgentNetwork,
  actions: SiteActionsApi,
  fetchImpl: typeof fetch = fetch
): Promise<AgentTurnOutput> {
  if (!profile.routerBaseUrl.trim() || !profile.modelName.trim()) {
    throw new Error("BYOK profile requires a router base URL and model name.");
  }
  const base = profile.routerBaseUrl.trim().replace(/\/+$/, "");
  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new Error("BYOK router base URL must be a valid URL.");
  }
  const isLoopback =
    (parsedBase.protocol === "http:" || parsedBase.protocol === "https:") &&
    (parsedBase.hostname === "localhost" ||
      parsedBase.hostname === "127.0.0.1" ||
      parsedBase.hostname === "[::1]");
  if (parsedBase.protocol !== "https:" && !isLoopback) {
    throw new Error("Remote BYOK router base URL must use HTTPS.");
  }
  if (!profile.apiKey.trim() && !isLoopback) {
    throw new Error("Missing API key for remote BYOK router.");
  }

  const frontAgent = network.tools[0];
  const systemPrompt = [
    frontAgent?.instructions ?? "Coordinate conformance checks using website_* tools.",
    "Always base answers strictly on tool outputs. Do not fabricate rule results.",
  ].join("\n\n");

  const messages: OpenAiMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const maxSteps = Math.min(network.max_steps ?? 8, 8);
  const toolCalls: AgentTurnOutput["toolCalls"] = [];
  const agentPath = [frontAgent?.name ?? "manifest_coordinator"];

  for (let step = 0; step < maxSteps; step += 1) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (profile.apiKey.trim()) {
      headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
    }

    const resp = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: profile.modelName,
        messages,
        tools: TOOL_SCHEMAS,
        tool_choice: "auto",
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`BYOK router returned HTTP ${resp.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`);
    }

    const json = (await resp.json()) as {
      choices?: Array<{
        message?: OpenAiMessage;
      }>;
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) {
      throw new Error("BYOK router returned an empty completion response.");
    }

    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        routerLabel: `BYOK (${profile.modelName})`,
        agentPath,
        toolCalls,
        replyText: msg.content ?? "(empty response)",
      };
    }

    for (const tc of msg.tool_calls) {
      const result = await dispatchSiteTool(tc.function.name, tc.function.arguments, actions);
      toolCalls.push({ tool: tc.function.name, result });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    routerLabel: `BYOK (${profile.modelName})`,
    agentPath,
    toolCalls,
    replyText: "Execution reached the configured max_steps bound before producing a final message.",
  };
}
