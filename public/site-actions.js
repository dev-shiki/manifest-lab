function getHostBridge() {
  if (typeof window !== "undefined" && window.__MANIFEST_LAB_ACTIONS__) {
    return window.__MANIFEST_LAB_ACTIONS__;
  }
  return null;
}

export const actions = {
  get_workbench_state: {
    effect: "read",
    description: "Read active bundle preset, state version, and last audit summary.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const host = getHostBridge();
      return host
        ? host.get_workbench_state()
        : { ok: false, status: "refused", effect: "read", reason: "Workbench host not mounted." };
    },
  },
  load_bundle_preset: {
    effect: "write",
    description: "Load one of the built-in bundle presets into the editor.",
    parameters: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["conforming", "leaky_sly_data", "unsafe_peer"] },
      },
      required: ["preset"],
    },
    handler: async (args) => {
      const host = getHostBridge();
      return host
        ? host.load_bundle_preset(args || {})
        : { ok: false, status: "refused", effect: "write", reason: "Workbench host not mounted." };
    },
  },
  run_conformance_audit: {
    effect: "write",
    description: "Execute all 16 Open Agentic Web MVP 0.2 conformance rules on the active bundle.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const host = getHostBridge();
      return host
        ? host.run_conformance_audit()
        : { ok: false, status: "refused", effect: "write", reason: "Workbench host not mounted." };
    },
  },
  simulate_peer_hop: {
    effect: "write",
    description: "Run a cross-origin peer hop with user consent and private-context filtering.",
    parameters: {
      type: "object",
      properties: {
        peerUrl: { type: "string" },
        request: { type: "string" },
      },
    },
    handler: async (args) => {
      const host = getHostBridge();
      return host
        ? host.simulate_peer_hop(args || {})
        : { ok: false, status: "refused", effect: "write", reason: "Workbench host not mounted." };
    },
  },
  clear_audit_workspace: {
    effect: "irreversible",
    description: "Clear audit findings and trace after verifying expected_version and confirmation.",
    parameters: {
      type: "object",
      properties: {
        expected_version: { type: "number" },
      },
      required: ["expected_version"],
    },
    handler: async (args) => {
      const host = getHostBridge();
      return host
        ? host.clear_audit_workspace(args || {})
        : { ok: false, status: "refused", effect: "irreversible", reason: "Workbench host not mounted." };
    },
  },
};

export default actions;
