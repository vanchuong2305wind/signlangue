"""Start an additional API on an available port; never stops an existing service."""

import argparse
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def reserve_socket(host, start):
    for port in range(start, min(start + 1000, 65536)):
        candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # Keep the bound socket until Uvicorn takes it, avoiding a port race.
            candidate.bind((host, port))
            candidate.listen(128)
            return candidate, port
        except OSError:
            candidate.close()
    raise RuntimeError("No free port in requested range")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Try this port, then next available")
    args = parser.parse_args()
    import uvicorn
    listener, port = reserve_socket(args.host, args.port)
    print(f"VieSign API: http://{args.host}:{port}", flush=True)
    try:
        server = uvicorn.Server(uvicorn.Config("app.api.server:app", host=args.host, port=port))
        server.run(sockets=[listener])
    finally:
        listener.close()


if __name__ == "__main__":
    main()
