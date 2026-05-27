import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "../../../../test/render";
import { TabBar } from "./TabBar";

const tabs = [
  { id: "general", label: "General" },
  { id: "advanced", label: "Advanced" },
  { id: "about", label: "About" },
];

describe("TabBar", () => {
  it("renders all tab buttons", () => {
    render(<TabBar tabs={tabs} activeTab="general" onTabChange={() => {}} />);
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Advanced")).toBeTruthy();
    expect(screen.getByText("About")).toBeTruthy();
  });

  it("renders the correct number of tab buttons", () => {
    render(<TabBar tabs={tabs} activeTab="general" onTabChange={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(3);
  });

  it("calls onTabChange with tab id when clicked", () => {
    const fn = mock();
    render(<TabBar tabs={tabs} activeTab="general" onTabChange={fn} />);
    fireEvent.click(screen.getByText("Advanced"));
    expect(fn).toHaveBeenCalledWith("advanced");
  });

  it("highlights the active tab with accent border color", () => {
    render(<TabBar tabs={tabs} activeTab="advanced" onTabChange={() => {}} />);
    const advancedBtn = screen.getByText("Advanced");
    // Active tab should have a non-transparent border-bottom-color
    expect(advancedBtn.style.borderBottomColor).not.toBe("transparent");
  });

  it("non-active tabs have transparent border", () => {
    render(<TabBar tabs={tabs} activeTab="advanced" onTabChange={() => {}} />);
    const generalBtn = screen.getByText("General");
    expect(generalBtn.style.borderBottomColor).toBe("transparent");
  });

  it("handles clicking multiple tabs", () => {
    const fn = mock();
    render(<TabBar tabs={tabs} activeTab="general" onTabChange={fn} />);
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByText("About"));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "advanced");
    expect(fn).toHaveBeenNthCalledWith(2, "about");
  });

  it("renders with a single tab", () => {
    render(
      <TabBar
        tabs={[{ id: "only", label: "Only Tab" }]}
        activeTab="only"
        onTabChange={() => {}}
      />,
    );
    expect(screen.getByText("Only Tab")).toBeTruthy();
    expect(screen.getAllByRole("button").length).toBe(1);
  });
});
