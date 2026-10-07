import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import DefaultProjectAccessSetting from "./default-project-access-setting";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-default-project-access",
  () => ({
    default: () => ({ data: { defaultProjectAccess: "none" } }),
  }),
);
const myAccess = vi.fn();
vi.mock("@/hooks/queries/workspace-users/use-get-my-project-access", () => ({
  default: () => myAccess(),
}));
vi.mock(
  "@/hooks/mutations/workspace-user/use-update-default-project-access",
  () => ({ default: () => ({ mutateAsync: vi.fn(), isPending: false }) }),
);
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

describe("DefaultProjectAccessSetting", () => {
  it("shows the workspace's current default", () => {
    myAccess.mockReturnValue({
      isPending: false,
      isError: false,
      data: { projectAccess: "all", projectIds: [] },
    });
    render(<DefaultProjectAccessSetting workspaceId="workspace-1" />);

    const trigger = screen.getByRole("combobox", {
      name: "team:defaultProjectAccess.label",
    });
    expect(trigger).toHaveTextContent("team:defaultProjectAccess.none");
    expect(trigger).not.toHaveAttribute("data-disabled");
    expect(
      screen.getByText("team:defaultProjectAccess.description"),
    ).toBeVisible();
  });

  it("can't be changed by someone whose own access is limited", () => {
    myAccess.mockReturnValue({
      isPending: false,
      isError: false,
      data: { projectAccess: "selected", projectIds: ["project-a"] },
    });
    render(<DefaultProjectAccessSetting workspaceId="workspace-1" />);

    expect(
      screen.getByRole("combobox", { name: "team:defaultProjectAccess.label" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByText("team:defaultProjectAccess.unavailable"),
    ).toBeVisible();
  });
});
