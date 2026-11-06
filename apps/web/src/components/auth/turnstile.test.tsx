import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Turnstile } from "./turnstile";

afterEach(() => {
  cleanup();
  delete window.turnstile;
});
it("binds the auth action and removes consumed widgets before a new attempt", async () => {
  const widget = {
    render: vi.fn().mockReturnValueOnce("first").mockReturnValueOnce("second"),
    remove: vi.fn(),
    reset: vi.fn(),
  };
  window.turnstile = widget;
  const verify = vi.fn();
  const { rerender } = render(
    <Turnstile key={0} siteKey="test" onVerify={verify} />,
  );
  await waitFor(() => expect(widget.render).toHaveBeenCalledTimes(1));
  expect(widget.render.mock.calls[0]?.[1]).toMatchObject({
    sitekey: "test",
    action: "auth",
  });
  widget.render.mock.calls[0]?.[1].callback("token");
  expect(verify).toHaveBeenCalledWith("token");
  rerender(<Turnstile key={1} siteKey="test" onVerify={verify} />);
  await waitFor(() => expect(widget.render).toHaveBeenCalledTimes(2));
  expect(widget.remove).toHaveBeenCalledWith("first");
});

it("downloads the script again when a retry follows a failed load", async () => {
  const scripts = () =>
    document.head.querySelectorAll("script[data-kaneo-turnstile]");
  const onError = vi.fn();
  const { rerender } = render(
    <Turnstile key={0} siteKey="test" onVerify={vi.fn()} onError={onError} />,
  );
  const failed = scripts()[0];
  failed?.dispatchEvent(new Event("error"));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(scripts()).toHaveLength(0);

  // Retry remounts the widget, as AuthCaptcha does with a new key.
  rerender(
    <Turnstile key={1} siteKey="test" onVerify={vi.fn()} onError={onError} />,
  );
  const retried = scripts()[0];
  expect(retried).toBeDefined();
  expect(retried).not.toBe(failed);
  const widget = { render: vi.fn(() => "w"), remove: vi.fn(), reset: vi.fn() };
  window.turnstile = widget;
  retried?.dispatchEvent(new Event("load"));
  await waitFor(() => expect(widget.render).toHaveBeenCalledTimes(1));
  expect(onError).toHaveBeenCalledTimes(1);
});
