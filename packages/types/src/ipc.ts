export interface RpcRequest {
  id: string;
  plugin: string;
  method: string;
  args: unknown[];
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: "event";
  plugin: string;
  event: string;
  data: unknown;
}

export type WsMessage = RpcResponse | RpcEvent;
