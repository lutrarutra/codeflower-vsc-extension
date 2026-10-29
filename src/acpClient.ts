// A minimal JSON-RPC 2.0 client for ACP over the code flower bridge: one
// compact JSON object per WebSocket text frame. It runs in the extension host
// because browser WebSockets cannot send the bridge's Authorization header.
import WebSocket from 'ws';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

type Message = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export const METHOD_NOT_FOUND = -32601;

export class AcpClient {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private requestHandler: RequestHandler = async (method) => {
    throw new RpcError({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
  };
  private notificationHandler: NotificationHandler = () => {};
  private readonly closeHandlers: Array<(reason: string) => void> = [];

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  async connect(url: string, token: string, timeoutMs = 15_000): Promise<void> {
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: timeoutMs,
      maxPayload: 16 * 1024 * 1024
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.receive(data.toString());
      }
    });
    socket.on('close', (code, reason) => {
      const text = reason.toString() || `connection closed (${code})`;
      for (const { reject } of this.pending.values()) {
        reject(new Error(text));
      }
      this.pending.clear();
      this.socket = undefined;
      for (const handler of this.closeHandlers) handler(text);
    });
    socket.on('error', () => {
      // The close event follows and reports the failure.
    });
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(JSON.stringify(id), { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(JSON.stringify(id));
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.socket?.close(1000, 'Client closed the connection');
  }

  private send(message: Message): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to a worker');
    }
    this.socket.send(JSON.stringify(message));
  }

  private receive(frame: string): void {
    let message: Message;
    try {
      message = JSON.parse(frame) as Message;
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      const id = message.id;
      this.requestHandler(message.method, message.params).then(
        (result) => this.trySend({ jsonrpc: '2.0', id, result: result ?? null }),
        (error: unknown) => {
          const rpc =
            error instanceof RpcError
              ? { code: error.code, message: error.message }
              : { code: -32603, message: error instanceof Error ? error.message : String(error) };
          this.trySend({ jsonrpc: '2.0', id, error: rpc });
        }
      );
      return;
    }
    if (message.method !== undefined) {
      this.notificationHandler(message.method, message.params);
      return;
    }
    const pending = this.pending.get(JSON.stringify(message.id));
    if (!pending) {
      return;
    }
    this.pending.delete(JSON.stringify(message.id));
    if (message.error) {
      pending.reject(new RpcError(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  private trySend(message: Message): void {
    try {
      this.send(message);
    } catch {
      // The connection closed while a handler was running.
    }
  }
}
