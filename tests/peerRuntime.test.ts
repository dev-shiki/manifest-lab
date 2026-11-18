import { describe, expect, it, vi } from "vitest";
import { BUNDLE_PRESETS } from "../src/core/fixtures";
import {
  deleteByokProfile,
  executePeerHop,
  filterSlyDataForPeer,
  loadByokProfile,
  saveByokProfile,
} from "../src/core/peerRuntime";
import { runByokAgentTurn } from "../src/runtime/byokRouter";
import {
  createInitialWorkbenchState,
  createSiteActions,
} from "../src/runtime/siteActions";

describe("peerRuntime, BYOK isolation, and site actions", () => {
  it("filters sly_data with deny-by-default and strips credential fields", () => {
    const res = filterSlyDataForPeer(
      {
        session_locale: "id-ID",
        visitor_api_key: "sk-secret",
        private_note: "do-not-share",
      },
      ["session_locale", "visitor_api_key", "*"]
    );
    expect(res.forwarded).toEqual({ session_locale: "id-ID" });
    expect(res.forwardedKeys).toEqual(["session_locale"]);
    expect(res.strippedKeys).toEqual(["visitor_api_key", "private_note"]);
  });

  it("enforces consent before fetch and never sends BYOK credentials to peer origin", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const stubFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url === "http://127.0.0.1:4173/peer_fixture/agent-manifest.json") {
        return new Response(
          JSON.stringify({
            networks: [
              {
                name: "civic_directory",
                front_man: "directory_front",
                hocon: "./civic_directory.network.json",
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url === "http://127.0.0.1:4173/peer_fixture/civic_directory.network.json") {
        return new Response(
          JSON.stringify({
            metadata: { description: "Civic directory fixture" },
            tools: [{ name: "directory_front", tools: [] }],
          }),
          { status: 200 }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const result = await executePeerHop({
      callerManifest: BUNDLE_PRESETS.conforming.manifest,
      callerNetwork: BUNDLE_PRESETS.conforming.network,
      peerNetworkUrl: "http://127.0.0.1:4173/peer_fixture/civic_directory",
      requestText: "List indexed conformance datasets.",
      slyData: {
        session_locale: "en-US",
        visitor_byok_key: "sk-real-key-never-forward",
      },
      fetchImpl: stubFetch,
      requestConsent: async (req) => {
        expect(req.peerOrigin).toBe("http://127.0.0.1:4173");
        expect(req.requestPreview140.length).toBeLessThanOrEqual(140);
        expect(req.allowedSlyFields).toEqual(["session_locale"]);
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(result.byokHeaderSentToPeer).toBe(false);
    expect(result.forwardedSlyKeys).toEqual(["session_locale"]);
    expect(result.strippedSlyKeys).toEqual(["visitor_byok_key"]);
    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      expect(call.init?.credentials).toBe("omit");
      expect(call.init?.headers).toBeUndefined();
    }
  });

  it("blocks unlisted peer origins without contacting fetch", async () => {
    const fetchSpy = vi.fn();
    const consentSpy = vi.fn();
    const result = await executePeerHop({
      callerManifest: BUNDLE_PRESETS.conforming.manifest,
      callerNetwork: BUNDLE_PRESETS.conforming.network,
      peerNetworkUrl: "https://unlisted.example/other_agent",
      requestText: "Hello",
      slyData: {},
      fetchImpl: fetchSpy as unknown as typeof fetch,
      requestConsent: consentSpy,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("denied");
    expect(consentSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cancels cleanly when visitor declines peer consent", async () => {
    const fetchSpy = vi.fn();
    const result = await executePeerHop({
      callerManifest: BUNDLE_PRESETS.conforming.manifest,
      callerNetwork: BUNDLE_PRESETS.conforming.network,
      peerNetworkUrl: "http://127.0.0.1:4173/peer_fixture/civic_directory",
      requestText: "Hello",
      slyData: {},
      fetchImpl: fetchSpy as unknown as typeof fetch,
      requestConsent: async () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores and deletes BYOK profiles in storage", () => {
    const map = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k) => map.get(k) ?? null,
      key: (i) => Array.from(map.keys())[i] ?? null,
      removeItem: (k) => {
        map.delete(k);
      },
      setItem: (k, v) => {
        map.set(k, v);
      },
    };

    saveByokProfile(
      {
        routerBaseUrl: "https://api.otari.ai/api/v1",
        modelName: "alibaba/qwen3.8-flash",
        apiKey: "sk-otari-demo",
      },
      storage
    );
    expect(loadByokProfile(storage)?.modelName).toBe("alibaba/qwen3.8-flash");
    deleteByokProfile(storage);
    expect(loadByokProfile(storage)).toBeNull();
  });

  it("enforces version guard and confirmation on irreversible clear_audit_workspace", async () => {
    let state = createInitialWorkbenchState();
    const actions = createSiteActions({
      getState: () => state,
      setState: (u) => {
        state = u(state);
      },
      requestIrreversibleConfirm: async () => true,
      requestPeerConsent: async () => true,
    });

    const stale = await actions.clear_audit_workspace({ expected_version: 999 });
    expect(stale.ok).toBe(false);
    expect(stale.status).toBe("refused");

    const ok = await actions.clear_audit_workspace({ expected_version: state.version });
    expect(ok.ok).toBe(true);
    expect(ok.effect).toBe("irreversible");
  });

  it("sends BYOK key strictly to routerBaseUrl during tool-calling turn", async () => {
    let state = createInitialWorkbenchState();
    const actions = createSiteActions({
      getState: () => state,
      setState: (u) => {
        state = u(state);
      },
      requestIrreversibleConfirm: async () => true,
      requestPeerConsent: async () => true,
    });

    let step = 0;
    const seenUrls: string[] = [];
    const seenAuths: Array<string | undefined> = [];

    const mockRouterFetch: typeof fetch = async (input, init) => {
      seenUrls.push(String(input));
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      seenAuths.push(hdrs.Authorization);
      step += 1;

      if (step === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "website_run_conformance_audit",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Audit passed all 16 checks.",
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    const output = await runByokAgentTurn(
      "Audit the current bundle",
      {
        routerBaseUrl: "https://router.example/v1",
        modelName: "test-model",
        apiKey: "sk-byok-only-router",
      },
      BUNDLE_PRESETS.conforming.network,
      actions,
      mockRouterFetch
    );

    expect(seenUrls).toEqual([
      "https://router.example/v1/chat/completions",
      "https://router.example/v1/chat/completions",
    ]);
    expect(seenAuths).toEqual([
      "Bearer sk-byok-only-router",
      "Bearer sk-byok-only-router",
    ]);
    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].tool).toBe("website_run_conformance_audit");
    expect(output.replyText).toContain("Audit passed");
  });

  it("blocks cross-origin hocon URL escaping the consented peer origin", async () => {
    const fetchedUrls: string[] = [];
    const stubFetch: typeof fetch = async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      return new Response(
        JSON.stringify({
          networks: [
            {
              name: "civic_directory",
              front_man: "directory_front",
              hocon: "https://evil.example/steal.network.json",
            },
          ],
        }),
        { status: 200 }
      );
    };

    const res = await executePeerHop({
      callerManifest: BUNDLE_PRESETS.conforming.manifest,
      callerNetwork: BUNDLE_PRESETS.conforming.network,
      peerNetworkUrl: "http://127.0.0.1:4173/peer_fixture/civic_directory",
      requestText: "Inspect dataset",
      slyData: { session_locale: "en-US" },
      fetchImpl: stubFetch,
      requestConsent: async () => true,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe("denied");
    expect(fetchedUrls).toEqual(["http://127.0.0.1:4173/peer_fixture/agent-manifest.json"]);
  });

  it("rejects cleartext remote HTTP and localhost.evil.com spoof in runByokAgentTurn", async () => {
    let state = createInitialWorkbenchState();
    const actions = createSiteActions({
      getState: () => state,
      setState: (u) => {
        state = u(state);
      },
      requestIrreversibleConfirm: async () => true,
      requestPeerConsent: async () => true,
    });

    await expect(
      runByokAgentTurn(
        "Audit bundle",
        {
          routerBaseUrl: "http://localhost.evil.com/v1",
          modelName: "test-model",
          apiKey: "sk-secret",
        },
        BUNDLE_PRESETS.conforming.network,
        actions
      )
    ).rejects.toThrow("Remote BYOK router base URL must use HTTPS.");

    await expect(
      runByokAgentTurn(
        "Audit bundle",
        {
          routerBaseUrl: "https://localhost.evil.com/v1",
          modelName: "test-model",
          apiKey: "",
        },
        BUNDLE_PRESETS.conforming.network,
        actions
      )
    ).rejects.toThrow("Missing API key for remote BYOK router.");
  });
});
