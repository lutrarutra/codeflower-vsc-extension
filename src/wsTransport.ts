// The extension host reaches a worker directly, with a `ws` socket that sends
// the worker's token in the Authorization header (a browser WebSocket cannot).
import type { Transport } from 'codeflower-ui/client/transport.ts';
import WebSocket from 'ws';
import type { WorkerAddress } from 'codeflower-ui/client/address.ts';

export async function wsTransport(address: WorkerAddress, timeoutMs = 15_000): Promise<Transport> {
  const socket = new WebSocket(address.url, {
    headers: { authorization: `Bearer ${address.token}` },
    handshakeTimeout: timeoutMs,
    maxPayload: 16 * 1024 * 1024
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (error) => reject(error));
  });
  socket.on('error', () => {
    // The close event follows and reports the failure.
  });
  return {
    get open() {
      return socket.readyState === WebSocket.OPEN;
    },
    send: (text) => socket.send(text),
    close: (code = 1000, reason = 'Client closed the connection') => socket.close(code, reason),
    onMessage: (listener) =>
      socket.on('message', (data, isBinary) => {
        if (!isBinary) listener(data.toString());
      }),
    onClose: (listener) => socket.on('close', (code, reason) => listener(code, reason.toString()))
  };
}
