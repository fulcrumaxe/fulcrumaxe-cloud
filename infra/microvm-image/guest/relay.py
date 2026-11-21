#!/usr/bin/python3
"""fx-relay: the guest side of the microVM's two egress relays (D#587 B-5b-RELAY). Standard library only.

The guest has no network card. Its tools are pointed at two loopback ports (`guestEnv.ts` in the runner says how), and this program carries
the bytes of each connection to a vsock port of the host (CID 2), where the sandbox's own listeners answer:

    127.0.0.1:5253  ->  host vsock 5253   the CONNECT proxy: `CONNECT host:443` tunnels to the hosts the sandbox's policy allows
    127.0.0.1:80    ->  host vsock 5254   the reverse endpoint: plain HTTP to a policy host, whose upstream TLS request the host makes

One process serves one pair: `relay.py <listen port> <vsock port>`. Only those two pairs are accepted, so this program can never be asked to
reach another host port. It copies bytes and decides nothing: which host is allowed, what a request may carry and where it goes are the
host listeners' decisions, taken from the socket a connection arrives on, never from anything sent here. It listens on 127.0.0.1 only. The
image gives the `ubuntu` user passwordless sudo, so this is a convenience for the tools and not a boundary; the boundary is the host's policy.

Each connection has its own pair of threads. At most MAX_CONNECTIONS are open at once; one more is closed at once. A connect to the host that
fails or takes longer than CONNECT_S closes the guest side. Bytes are never stored beyond one CHUNK in flight, and a half-close is passed on
(so a request body that ends, or a response that ends, is seen as ending); a reset on either side ends both.
"""
import socket
import sys
import threading
import time

HOST_CID = 2
CHUNK = 64 << 10
MAX_CONNECTIONS = 128
CONNECT_S = 10
LINGER_S = 30
# The only pairs this program serves: (loopback port, host vsock port).
PAIRS = {(5253, 5253), (80, 5254)}


def connect_host(vsock_port):
    """A connection to a vsock port of the host. Tests replace this."""
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        s.settimeout(CONNECT_S)
        s.connect((HOST_CID, vsock_port))
        s.settimeout(None)
    except OSError:
        s.close()
        raise
    return s


def pump(src, dst):
    """Copies src to dst until src ends. A clean end is passed on as a half-close; an error ends both sockets in both directions."""
    clean = False
    try:
        while True:
            data = src.recv(CHUNK)
            if not data:
                clean = True
                break
            dst.sendall(data)
    except OSError:
        pass
    for s, how in ((dst, socket.SHUT_WR),) if clean else ((src, socket.SHUT_RDWR), (dst, socket.SHUT_RDWR)):
        try:
            s.shutdown(how)
        except OSError:
            pass


def serve_one(client, vsock_port, connect, slots):
    try:
        try:
            host = connect(vsock_port)
        except OSError:
            return
        try:
            up = threading.Thread(target=pump, args=(client, host), daemon=True)
            up.start()
            pump(host, client)
            up.join(LINGER_S)  # the host has ended; a client that still holds its side open after that is not waited for for long
        finally:
            for s in (client, host):
                try:
                    s.shutdown(socket.SHUT_RDWR)  # unblocks a thread still reading the other side
                except OSError:
                    pass
            host.close()
    finally:
        client.close()
        slots.release()


def serve(listener, vsock_port, connect=connect_host):
    """Accepts forever on `listener`."""
    slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            time.sleep(0.05)  # a failed accept (out of descriptors, an aborted connection) is not the end of the relay
            continue
        if not slots.acquire(blocking=False):
            client.close()
            continue
        threading.Thread(target=serve_one, args=(client, vsock_port, connect, slots), daemon=True).start()


def listen(port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(64)
    return srv


def main(argv):
    try:
        pair = (int(argv[1]), int(argv[2]))
    except (IndexError, ValueError):
        pair = None
    if len(argv) != 3 or pair not in PAIRS:
        print("usage: relay.py 5253 5253 | relay.py 80 5254", file=sys.stderr)
        return 2
    srv = listen(pair[0])
    print(f"FXMARK relay_listening port={pair[0]} vsock={pair[1]}", flush=True)
    serve(srv, pair[1])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
