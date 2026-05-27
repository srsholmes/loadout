import { describe, it, expect } from "bun:test";
import type { RpcRequest, RpcResponse, RpcEvent } from "./ipc";

describe("IPC types", () => {
  it("RpcRequest conforms to shape", () => {
    const req: RpcRequest = {
      id: "abc-123",
      plugin: "hello-world",
      method: "getJoke",
      args: [],
    };
    expect(req.id).toBe("abc-123");
    expect(req.plugin).toBe("hello-world");
    expect(req.method).toBe("getJoke");
    expect(req.args).toEqual([]);
  });

  it("RpcResponse can carry a result", () => {
    const res: RpcResponse = { id: "abc-123", result: "a joke" };
    expect(res.result).toBe("a joke");
    expect(res.error).toBeUndefined();
  });

  it("RpcResponse can carry an error", () => {
    const res: RpcResponse = { id: "abc-123", error: "not found" };
    expect(res.error).toBe("not found");
    expect(res.result).toBeUndefined();
  });

  it("RpcEvent conforms to shape", () => {
    const event: RpcEvent = {
      type: "event",
      plugin: "hello-world",
      event: "newJoke",
      data: { joke: "ha" },
    };
    expect(event.type).toBe("event");
    expect(event.data).toEqual({ joke: "ha" });
  });
});
