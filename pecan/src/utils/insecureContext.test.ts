import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, createId } from "./insecureContext";

describe("createId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("works without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(171),
    });

    expect(createId()).toBe("ab".repeat(16));
  });
});

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubClipboard(clipboard: unknown) {
    vi.stubGlobal("navigator", { clipboard });
  }

  function stubExecCommand(result: boolean) {
    const execCommand = vi.fn(() => result);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });
    return execCommand;
  }

  it("uses the clipboard API when it exists", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    expect(await copyText("code")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("code");
  });

  it("falls back when there is no clipboard API, as on plain HTTP", async () => {
    stubClipboard(undefined);
    const execCommand = stubExecCommand(true);

    expect(await copyText("code")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports a failed copy", async () => {
    stubClipboard(undefined);
    stubExecCommand(false);

    expect(await copyText("code")).toBe(false);
  });
});
