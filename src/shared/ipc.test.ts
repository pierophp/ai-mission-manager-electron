import { describe, expect, it } from "vitest";
import { createCommandDispatcher, invokeEnvelope } from "./ipc";

describe("command IPC envelope", () => {
  it("delivers the backend error text to the renderer unchanged", async () => {
    const dispatch = createCommandDispatcher({
      fail: () => {
        throw "erro original do backend";
      },
    });

    await expect(invokeEnvelope(dispatch, "fail")).rejects.toBe("erro original do backend");
  });

  it("answers unimplemented commands with a readable error", async () => {
    await expect(invokeEnvelope(createCommandDispatcher(), "list_contexts"))
      .rejects.toBe("não implementado: list_contexts");
  });
});
