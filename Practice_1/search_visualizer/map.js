"use strict";

const countyMap = (() => {
  const canvas = document.getElementById("county-map");
  const context = canvas.getContext("2d");
  const byName = new Map();
  const countyShapes = [];
  const stateShapes = [];
  const fips = "01AL 02AK 04AZ 05AR 06CA 08CO 09CT 10DE 11DC 12FL 13GA 15HI 16ID 17IL 18IN 19IA 20KS 21KY 22LA 23ME 24MD 25MA 26MI 27MN 28MS 29MO 30MT 31NE 32NV 33NH 34NJ 35NM 36NY 37NC 38ND 39OH 40OK 41OR 42PA 44RI 45SC 46SD 47TN 48TX 49UT 50VT 51VA 53WA 54WV 55WI 56WY".split(" ");
  const states = new Map(fips.map((entry) => [entry.slice(0, 2), entry.slice(2)]));
  const colors = {Blue: "#a9c8ff", Red: "#ffb2a5"};
  let simulation, frame, loaded = false, failure = false, fit = false, markers = [];

  function nameKey(name) {
    const [county, state] = name.split(/,\s*(?=[A-Z]{2}$)/);
    const base = county.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\s+(city and borough|census area|municipality|county|parish|borough|city)$/, "")
      .replace(/[^a-z0-9]/g, "");
    return state + ":" + base;
  }

  function prepare(topology) {
    const {scale, translate} = topology.transform;
    const arcs = topology.arcs.map((arc) => {
      let x = 0, y = 0;
      return arc.map(([dx, dy]) => {
        x += dx;
        y += dy;
        return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
      });
    });

    function shape(geometry) {
      const path = new Path2D();
      let center = null, largest = -Infinity;
      const polygons = geometry.type === "Polygon" ? [geometry.arcs] : geometry.arcs;
      for (const rings of polygons) {
        for (const [index, ring] of rings.entries()) {
          const points = ring.flatMap((ref) => ref < 0 ? [...arcs[~ref]].reverse() : arcs[ref]);
          if (points.length === 0) continue;
          path.moveTo(...points[0]);
          for (const point of points.slice(1)) path.lineTo(...point);
          path.closePath();
          if (index) continue;
          let area = 0, cx = 0, cy = 0;
          for (let i = 0; i < points.length; i++) {
            const [x, y] = points[i], [nx, ny] = points[(i + 1) % points.length];
            const cross = x * ny - nx * y;
            area += cross;
            cx += (x + nx) * cross;
            cy += (y + ny) * cross;
          }
          if (Math.abs(area) > largest && area) {
            center = [cx / (3 * area), cy / (3 * area)];
            largest = Math.abs(area);
          }
        }
      }
      return {path, center};
    }

    for (const county of topology.objects.counties.geometries) {
      const id = String(county.id).padStart(5, "0");
      const state = states.get(id.slice(0, 2));
      if (!state || !county.arcs) continue;
      const item = shape(county);
      if (!item.center) continue;
      countyShapes.push(item);
      const key = nameKey(county.properties.name + ", " + state);
      const isCity = Number(id.slice(2)) >= 500 && ["VA", "MD", "MO", "NV"].includes(state);
      if (!isCity || !byName.has(key)) byName.set(key, item);
      if (isCity) byName.set(key + ":city", item);
    }
    for (const state of topology.objects.states.geometries) {
      if (states.has(String(state.id).padStart(2, "0"))) stateShapes.push(shape(state));
    }
    loaded = countyShapes.length > 0;
  }

  function lookup(name) {
    const key = nameKey(name);
    return (/ city,/i.test(name) && byName.get(key + ":city")) || byName.get(key);
  }

  function draw() {
    const note = document.getElementById("map-note");
    if (!loaded) {
      note.textContent = failure
        ? "County boundaries could not load. The assignment diagram and route list are still available."
        : "Loading county boundaries…";
      return;
    }
    const routes = [];
    const missing = new Set();
    const starts = simulation?.locations ?? [];
    const hubs = new Map();
    const coordinates = [];
    function locate(name) {
      const item = lookup(name);
      if (item) coordinates.push(item.center);
      else missing.add(name);
      return item;
    }
    const startingShapes = starts.map(([name, party], index) => ({
      name, party, item: locate(name), waiting: !frame || frame.remaining.includes(index),
    }));
    for (const [indices, [hub, party]] of frame?.groups ?? []) {
      hubs.set(hub + party, {name: hub, party, item: locate(hub), hub: true});
      for (const index of indices) {
        const route = simulation.routeIndex.get(JSON.stringify([index, hub]));
        routes.push({party, points: route.path.map(locate)});
      }
    }

    let zoom = 1, offsetX = 0, offsetY = 0;
    if (fit && coordinates.length) {
      const xs = coordinates.map(([x]) => x), ys = coordinates.map(([, y]) => y);
      const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
      zoom = Math.min(4, 855 / Math.max(1, right - left), 490 / Math.max(1, bottom - top));
      offsetX = (975 - (left + right) * zoom) / 2;
      offsetY = (610 - (top + bottom) * zoom) / 2;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, 975, 610);
    context.setTransform(zoom, 0, 0, zoom, offsetX, offsetY);
    context.fillStyle = "#302e49";
    context.strokeStyle = "#4a4665";
    context.lineWidth = 0.55 / zoom;
    for (const {path} of countyShapes) {
      context.fill(path);
      context.stroke(path);
    }
    context.strokeStyle = "#827a9e";
    context.lineWidth = 0.95 / zoom;
    for (const {path} of stateShapes) context.stroke(path);

    for (const {party, points} of routes) {
      context.strokeStyle = colors[party];
      context.lineWidth = 2.3 / zoom;
      context.beginPath();
      let connected = false;
      for (const point of points) {
        if (!point) { connected = false; continue; }
        if (connected) context.lineTo(...point.center);
        else context.moveTo(...point.center);
        connected = true;
      }
      context.stroke();
    }
    markers = [];
    for (const marker of [...startingShapes, ...hubs.values()]) {
      if (!marker.item) continue;
      const [x, y] = marker.item.center;
      const r = (marker.hub ? 8 : 4.5) / zoom;
      context.strokeStyle = marker.waiting ? colors[marker.party] : "#222139";
      context.lineWidth = 1.5 / zoom;
      context.fillStyle = marker.waiting ? "#25233d" : colors[marker.party];
      context.beginPath();
      if (marker.hub) {
        context.moveTo(x, y - r);
        context.lineTo(x + r, y);
        context.lineTo(x, y + r);
        context.lineTo(x - r, y);
        context.closePath();
      } else {
        context.arc(x, y, r, 0, Math.PI * 2);
      }
      context.fill();
      context.stroke();
      markers.push({...marker, x: x * zoom + offsetX, y: y * zoom + offsetY});
    }
    note.replaceChildren(document.createTextNode("Routes connect county centers. Boundaries: "));
    const source = document.createElement("a");
    source.href = "https://github.com/topojson/us-atlas";
    source.textContent = "U.S. Atlas";
    note.append(source);
    if (missing.size) note.append(document.createTextNode(". No boundary match for " + [...missing].join(", ") + "."));
  }

  canvas.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * 975 / box.width;
    const y = (event.clientY - box.top) * 610 / box.height;
    const hit = [...markers].reverse().find((marker) => Math.hypot(x - marker.x, y - marker.y) < 13);
    canvas.title = hit ? hit.name + " · " + hit.party + (hit.hub ? " hub" : " start") : "";
  });

  function setView(map) {
    document.getElementById("map-panel").hidden = !map;
    document.getElementById("diagram").hidden = map;
    document.getElementById("map-fit").hidden = !map;
    document.getElementById("map-view").setAttribute("aria-pressed", map);
    document.getElementById("diagram-view").setAttribute("aria-pressed", !map);
  }

  document.getElementById("map-view").onclick = () => setView(true);
  document.getElementById("diagram-view").onclick = () => setView(false);
  document.getElementById("map-fit").onclick = (event) => {
    fit = !fit;
    event.currentTarget.setAttribute("aria-pressed", fit);
    event.currentTarget.textContent = fit ? "Show full U.S." : "Fit scenario";
    draw();
  };

  async function fetchAtlas(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("County atlas unavailable");
    return response.json();
  }

  fetchAtlas("https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-albers-10m.json")
    .catch(() => fetchAtlas("https://unpkg.com/us-atlas@3.0.1/counties-albers-10m.json"))
    .then((topology) => { prepare(topology); draw(); })
    .catch(() => { failure = true; draw(); });

  return {update(result, active) { simulation = result; frame = active; draw(); }};
})();
