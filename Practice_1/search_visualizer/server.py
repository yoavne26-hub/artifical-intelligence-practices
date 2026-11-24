"""Local, standard-library server for the A* replay tool."""

import argparse
import importlib.util
import json
from heapq import nsmallest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOLVER_PATH = ROOT.parent / "hub_search" / "q1.py"


def load_solver():
    spec = importlib.util.spec_from_file_location("hub_solver", SOLVER_PATH)
    solver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(solver)
    return solver


GRAPH = load_solver().load_county_graph()


def simulate(request):
    entries = request["locations"]
    slots = request["slots"]
    if type(slots) is not int or not 1 <= slots <= 12:
        raise ValueError("Choose between 1 and 12 hub slots.")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 12:
        raise ValueError("Enter between 1 and 12 starting locations.")
    locations = []
    for entry in entries:
        if not isinstance(entry, list) or len(entry) != 2:
            raise ValueError("Each location needs a county and a party.")
        county, party = entry
        if not isinstance(county, str) or county not in GRAPH:
            raise ValueError(f"County unavailable in the dataset: {county}")
        if party not in ("Blue", "Red"):
            raise ValueError("Choose Blue or Red for each county.")
        locations.append((county, party))

    # A separate module instance confines the queue observer to this request.
    solver = load_solver()
    bfs = {county: solver.shortest_paths(GRAPH, county) for county in dict.fromkeys(c for c, _ in locations)}
    distances = {county: result[0] for county, result in bfs.items()}
    frames = []
    pop = solver.heappop
    visited = set()

    def observe(queue):
        entry = pop(queue)
        f, h, _, remaining, available, groups = entry
        state = (remaining, available)
        upcoming = [dict(f=item[0], h=item[1], waiting=len(item[3]))
                    for item in nsmallest(3, queue)]
        frames.append(dict(g=f-h, h=h, f=f, remaining=remaining, slots=available,
                           frontier=len(queue), groups=groups, upcoming=upcoming,
                           revisited=state in visited))
        visited.add(state)
        return entry

    solver.heappop = observe
    result = solver.search_hubs(locations, slots, distances)

    # Routes are reconstructed once for every assignment appearing in the replay.
    routes = {}
    for frame in frames:
        for group, (hub, _) in frame["groups"]:
            for index in group:
                key = (index, hub)
                if key in routes:
                    continue
                county = locations[index][0]
                predecessors = bfs[county][1]
                path = [hub]
                while path[-1] != county:
                    path.append(predecessors[path[-1]])
                routes[key] = list(reversed(path))
    return dict(locations=locations, frames=frames, cost=None if result is None else result[1],
                routes=[dict(index=index, hub=hub, path=path) for (index, hub), path in routes.items()])


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status, data, mime):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        files = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                 "/style.css": ("style.css", "text/css"), "/map.js": ("map.js", "text/javascript")}
        if self.path == "/api/counties":
            self.send_bytes(200, json.dumps(sorted(GRAPH)).encode(), "application/json")
        elif self.path in files:
            filename, mime = files[self.path]
            self.send_bytes(200, (ROOT / filename).read_bytes(), mime + "; charset=utf-8")
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/api/simulate":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 8192:
                raise ValueError("The scenario is empty or too large.")
            data = simulate(json.loads(self.rfile.read(size)))
            self.send_bytes(200, json.dumps(data).encode(), "application/json")
        except (KeyError, TypeError, ValueError) as error:
            self.send_bytes(400, json.dumps({"error": str(error)}).encode(), "application/json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"A* visualizer at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
