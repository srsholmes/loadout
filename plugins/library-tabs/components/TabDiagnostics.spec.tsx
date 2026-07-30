import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabDiagnostics } from "./TabDiagnostics";
import type { Diagnosis } from "../lib/diagnose";

function diagnosis(): Diagnosis {
  return {
    kind: "single-culprit",
    ruleId: "r1",
    wouldMatch: 214,
    message: 'Remove "is not installed" and 214 games match',
    fixes: [{ label: 'Remove "is not installed"', apply: (tab) => tab }],
  };
}

describe("TabDiagnostics", () => {
  it("explains the problem whether or not the tab is editable", () => {
    render(
      <TabDiagnostics diagnosis={diagnosis()} onApplyFix={() => {}} editable={false} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("214 games match");
  });

  it("offers one-tap fixes on an editable tab", () => {
    const onApplyFix = mock(() => {});
    render(<TabDiagnostics diagnosis={diagnosis()} onApplyFix={onApplyFix} editable />);
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(onApplyFix).toHaveBeenCalledTimes(1);
  });

  it("offers NO fixes on a built-in, whose rules are not the user's to edit", () => {
    // A fix is a `Tab -> Tab` the caller persists. On a builtin, "remove the
    // rule excluding everything" permanently guts a shipped tab — and on a real
    // device that is exactly how `recent` and `never-played` ended up with no
    // rules while their data source was missing.
    render(
      <TabDiagnostics diagnosis={diagnosis()} onApplyFix={() => {}} editable={false} />,
    );
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("renders nothing at all when the tab is healthy", () => {
    const { container } = render(
      <TabDiagnostics diagnosis={{ kind: "ok" }} onApplyFix={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
