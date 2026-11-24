"""Find campaign hubs using shortest-path distances and A* search."""

import csv
from collections import deque
from functools import lru_cache
from heapq import heappop, heappush
from itertools import combinations, count
from math import inf
from pathlib import Path

# Python can clear __file__ after the script hands control to the interactive prompt.
SCRIPT_DIR = Path(__file__).resolve().parent


def load_county_graph(csv_path=None):
    """Read the CSV into an undirected map of counties to their neighbors."""
    if csv_path is None:
        csv_path = SCRIPT_DIR / "adjacency.csv"
        if not csv_path.is_file():
            csv_path = csv_path.parent.parent / "adjacency.csv"

    graph = {}
    with open(csv_path, encoding="utf-8-sig", newline="") as source:
        for county, neighbor in csv.reader(source):
            graph.setdefault(county, set())
            graph.setdefault(neighbor, set())
            if county != neighbor:
                graph[county].add(neighbor)
                graph[neighbor].add(county)

    return {county: sorted(neighbors) for county, neighbors in graph.items()}


def shortest_paths(graph, start):
    """Return BFS distances and predecessors for all counties reachable from start."""
    if start not in graph:
        raise ValueError(f"Unknown county: {start}")

    distances = {start: 0}
    predecessors = {start: None}
    frontier = deque([start])

    while frontier:
        county = frontier.popleft()
        for neighbor in graph[county]:
            if neighbor in distances:
                continue
            distances[neighbor] = distances[county] + 1
            predecessors[neighbor] = county
            frontier.append(neighbor)

    return distances, predecessors


def cheapest_hub(group, distances_by_county):
    """Return (county, total cost) for one group, or None if no hub is reachable."""
    distance_maps = [distances_by_county[county] for county in group]
    if not distance_maps:
        raise ValueError("A hub group must have at least one starting location.")

    candidates = set(distance_maps[0])
    for distances in distance_maps[1:]:
        candidates.intersection_update(distances)

    if not candidates:
        return None

    cost, county = min(
        (sum(distances[county] for distances in distance_maps), county)
        for county in candidates
    )
    return county, cost


def remaining_cost_lower_bound(remaining, hub_slots, locations, edges):
    """Combine the counting and minimum spanning forest lower bounds."""
    distinct_locations = {tuple(locations[index]) for index in remaining}
    counting_bound = max(0, len(distinct_locations) - hub_slots)
    if len(remaining) <= hub_slots:
        return counting_bound

    # Kruskal's algorithm stops once there is room for one hub per tree.
    parents = {index: index for index in remaining}
    tree_count = len(remaining)
    forest_weight = 0

    def root(index):
        while parents[index] != index:
            index = parents[index]
        return index

    for distance, first, second in edges:
        if first not in parents or second not in parents:
            continue
        first_root, second_root = root(first), root(second)
        if first_root == second_root:
            continue
        parents[second_root] = first_root
        forest_weight += distance
        tree_count -= 1
        if tree_count == hub_slots:
            return max(counting_bound, (forest_weight + 1) // 2)

    return inf


def search_hubs(locations, hub_limit, distances_by_county):
    """Return (assignments in input order, total cost, initial bound), or None."""
    if hub_limit < 0:
        raise ValueError("The hub limit must be nonnegative.")

    all_locations = tuple(range(len(locations)))
    edges = []
    for first, second in combinations(all_locations, 2):
        first_county, first_party = locations[first]
        second_county, second_party = locations[second]
        if first_party == second_party and second_county in distances_by_county[first_county]:
            distance = distances_by_county[first_county][second_county]
            edges.append((distance, first, second))
    edges.sort()

    initial_bound = remaining_cost_lower_bound(all_locations, hub_limit, locations, edges)
    if initial_bound == inf:
        return None

    @lru_cache(maxsize=None)
    def score_group(group):
        return cheapest_hub((locations[index][0] for index in group), distances_by_county)

    order = count()
    frontier = [(initial_bound, initial_bound, next(order), all_locations, hub_limit, ())]
    best_cost = {(all_locations, hub_limit): 0}
    while frontier:
        priority, bound, _, remaining, hub_slots, groups = heappop(frontier)
        cost = priority - bound
        if cost != best_cost[remaining, hub_slots]:
            continue
        if not remaining:
            assignments = [None] * len(locations)
            for group, hub in groups:
                for index in group:
                    assignments[index] = hub
            return assignments, cost, initial_bound

        # Anchoring each group at the first unassigned location avoids
        # generating the same partition in different orders.
        first, *others = remaining
        county, party = locations[first]
        partners = [
            index for index in others
            if locations[index][1] == party and locations[index][0] in distances_by_county[county]
        ]
        next_slots = hub_slots - 1
        for partner_count in range(len(partners) + 1):
            for members in combinations(partners, partner_count):
                next_remaining = tuple(index for index in others if index not in members)
                next_bound = remaining_cost_lower_bound(next_remaining, next_slots, locations, edges)
                if next_bound == inf:
                    continue

                group = (first, *members)
                hub, group_cost = score_group(group)
                next_cost = cost + group_cost
                state = (next_remaining, next_slots)
                if next_cost >= best_cost.get(state, inf):
                    continue
                best_cost[state] = next_cost
                next_groups = groups + ((group, (hub, party)),)
                entry = (next_cost + next_bound, next_bound, next(order),
                         next_remaining, next_slots, next_groups)
                heappush(frontier, entry)

    return None


def find_hub(locations, hub_number, search_method, detail_output):
    """Find same-party campaign hubs and print assignments and routes."""
    if search_method != 1:
        raise ValueError("Search method 1 (A*) is supported.")

    locations = list(locations)
    graph = load_county_graph()
    distances_by_county = {}
    predecessors_by_county = {}
    for county, _ in locations:
        if county not in distances_by_county:
            distances, predecessors = shortest_paths(graph, county)
            distances_by_county[county] = distances
            predecessors_by_county[county] = predecessors

    result = search_hubs(locations, hub_number, distances_by_county)
    if result is None:
        assignments = [None] * len(locations)
        total_cost = 0
        heuristic = inf
    else:
        assignments, total_cost, _ = result
        # The reported solution is a goal state with no cost remaining.
        heuristic = 0

    def format_hub(hub):
        if hub is None:
            return "No hub assigned"
        county, party = hub
        return f"{county} ({party[0].upper()})"

    hubs = dict.fromkeys(hub for hub in assignments if hub is not None)
    print("Hubs:", "{" + " ; ".join(map(format_hub, hubs)) + "}", sep="\n")
    print("Assignments:", "{" + " ; ".join(map(format_hub, assignments)) + "}", sep="\n")
    print("Cost:", total_cost, sep="\n")
    if detail_output:
        print("Heuristic:", heuristic, sep="\n")

    print("Paths:")
    for (start, _), hub in zip(locations, assignments):
        if hub is None:
            print("No hub assigned")
            continue

        destination, _ = hub
        predecessors = predecessors_by_county[start]
        route = [destination]
        while route[-1] != start:
            route.append(predecessors[route[-1]])

        print("{" + " ; ".join(reversed(route)) + "}")
        print(f"Cost: {distances_by_county[start][destination]}")
