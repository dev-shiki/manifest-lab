import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mountManifestLabApp } from "../src/ui/main";

describe("ManifestLab UI integration", () => {
  beforeEach(() => {
    const html = readFileSync(path.resolve(__dirname, "../index.html"), "utf-8");
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    document.documentElement.setAttribute("data-theme", "light");
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : "";
    mountManifestLabApp();
  });

  it("loads presets, runs 16-rule audit, and renders pass/fail DOM states", () => {
    const runAuditBtn = document.getElementById("run-audit-btn") as HTMLButtonElement;
    const exportBtn = document.getElementById("export-report-btn") as HTMLButtonElement;
    const summary = document.getElementById("audit-summary") as HTMLDivElement;

    expect(exportBtn.disabled).toBe(true);
    runAuditBtn.click();

    expect(exportBtn.disabled).toBe(false);
    expect(summary.textContent).toContain("CONFORMANT");
    expect(summary.textContent).toContain("16 Pass");

    const leakyBtn = document.querySelector<HTMLButtonElement>('[data-preset="leaky_sly_data"]')!;
    leakyBtn.click();
    runAuditBtn.click();
    expect(summary.textContent).toContain("NON-CONFORMANT");
  });

  it("toggles light and dark theme cleanly", () => {
    const themeBtn = document.getElementById("theme-toggle-btn") as HTMLButtonElement;
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    themeBtn.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(themeBtn.getAttribute("aria-pressed")).toBe("true");
    themeBtn.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("runs deterministic agent turn and closes reset confirmation modal on Escape", async () => {
    const promptInput = document.getElementById("agent-prompt-input") as HTMLInputElement;
    const form = document.getElementById("agent-chat-form") as HTMLFormElement;
    const agentOutput = document.getElementById("agent-output-box") as HTMLDivElement;

    promptInput.value = "Audit the currently loaded bundle";
    form.dispatchEvent(new Event("submit", { cancelable: true }));

    await new Promise((r) => setTimeout(r, 20));
    expect(agentOutput.hidden).toBe(false);
    expect(agentOutput.textContent).toContain("Offline Deterministic Router");
    expect(agentOutput.textContent).toContain("16/16 rules passed");

    const resetBtn = document.getElementById("reset-workspace-btn") as HTMLButtonElement;
    const modal = document.getElementById("modal-backdrop") as HTMLDivElement;
    resetBtn.click();
    expect(modal.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(modal.hidden).toBe(true);
  });
});
