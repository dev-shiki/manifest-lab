import { describe, expect, it } from "vitest";
import { auditAgenticBundle } from "../src/core/auditor";
import { BUNDLE_PRESETS } from "../src/core/fixtures";

describe("auditAgenticBundle (16 MVP Profile 0.2 rules)", () => {
  it("passes all 16 rules on the conforming ManifestLab self bundle", () => {
    const report = auditAgenticBundle(BUNDLE_PRESETS.conforming);
    expect(report.conformant).toBe(true);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.warn).toBe(0);
    expect(report.counts.pass).toBe(16);
    expect(report.discoveredPeerUrls).toContain(
      "http://127.0.0.1:4173/peer_fixture/civic_directory"
    );
  });

  it("catches sly_data wildcard, leaked key, unexpanded placeholder, and unsafe instructions", () => {
    const report = auditAgenticBundle(BUNDLE_PRESETS.leaky_sly_data);
    expect(report.conformant).toBe(false);

    const byId = new Map(report.findings.map((f) => [f.ruleId, f]));
    expect(byId.get("MVS-2.1-LOCAL-REFS")?.severity).toBe("fail");
    expect(byId.get("MVS-2.1-REACHABILITY")?.severity).toBe("warn");
    expect(byId.get("MVS-2.2-DATA-ONLY")?.severity).toBe("fail");
    expect(byId.get("MVS-4.0-BYOK-HYGIENE")?.severity).toBe("fail");
    expect(byId.get("MVS-5.0-SLY-DATA-DENY")?.severity).toBe("fail");
    expect(byId.get("MVS-5.0-UNTRUSTED-INSTRUCTIONS")?.severity).toBe("fail");
    expect(byId.get("MVS-3.4-MCP-CORS-HONESTY")?.severity).toBe("fail");
  });

  it("catches non-loopback HTTP peer URLs and peer_policy violations", () => {
    const report = auditAgenticBundle(BUNDLE_PRESETS.unsafe_peer);
    expect(report.conformant).toBe(false);

    const byId = new Map(report.findings.map((f) => [f.ruleId, f]));
    expect(byId.get("MVS-3.2-PEER-HTTPS")?.severity).toBe("fail");
    expect(byId.get("MVS-3.2-PEER-POLICY")?.severity).toBe("fail");
  });
});
