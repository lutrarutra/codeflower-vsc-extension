// The extension host reaches a worker directly, with a `ws` socket that sends
// the worker's token in the Authorization header (a browser WebSocket cannot).
// A worker whose line has a fingerprint (fp=) serves TLS with a certificate
// no authority signed: the socket is used only once the certificate has that
// fingerprint, so the token never reaches anyone standing in for the worker.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Agent, type RequestOptions } from 'node:https';
import type { Duplex } from 'node:stream';
import { connect, type ConnectionOptions } from 'node:tls';
import type { Transport } from 'codeflower-ui/client/transport.ts';
import WebSocket from 'ws';
import type { WorkerAddress } from 'codeflower-ui/client/address.ts';

/** A certificate's fingerprint: SHA-256 of its DER, unpadded base64url, as the worker prints it. */
export function certificateFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url');
}

/**
 * Hands out a connection only after the TLS handshake, and only if the
 * server's certificate has the fingerprint; the request (and its token) is
 * written after that.
 */
export class PinnedAgent extends Agent {
  private readonly fingerprint: string;

  constructor(fingerprint: string) {
    super({ keepAlive: false });
    this.fingerprint = fingerprint;
  }

  override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Duplex) => void): undefined {
    let answered = false;
    // The socket only reaches the request once it passed.
    const answer = (error: Error | null, stream: Duplex) => {
      if (answered) return;
      answered = true;
      callback?.(error, stream);
    };
    // The fingerprint stands in for an authority's signature.
    const socket = connect({ ...(options as ConnectionOptions), rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    socket.once('secureConnect', () => {
      const seen = Buffer.from(certificateFingerprint(socket.getPeerCertificate().raw ?? Buffer.alloc(0)));
      const expected = Buffer.from(this.fingerprint);
      if (seen.length === expected.length && timingSafeEqual(seen, expected)) return answer(null, socket);
      socket.destroy();
      answer(new Error("The worker's certificate does not match its address: it is not the worker that printed the line."), socket);
    });
    socket.once('error', (error) => answer(error, socket));
    return undefined;
  }
}

export async function wsTransport(address: WorkerAddress, timeoutMs = 15_000): Promise<Transport> {
  const socket = new WebSocket(address.url, {
    headers: { authorization: `Bearer ${address.token}` },
    handshakeTimeout: timeoutMs,
    maxPayload: 16 * 1024 * 1024,
    ...(address.fingerprint ? { agent: new PinnedAgent(address.fingerprint) } : {})
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
