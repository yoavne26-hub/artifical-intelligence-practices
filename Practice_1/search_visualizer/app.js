"use strict";

const get = (id) => document.getElementById(id);
const handout = [["Washington County, UT", "Blue"], ["Hudspeth County, TX", "Blue"], ["Fairfield County, CT", "Red"]];
const presets = {
  handout: [2, handout],
  impossible: [1, handout],
  nationwide: [3, ["San Diego County, CA", "King County, WA", "Miami-Dade County, FL", "Cook County, IL", "Harris County, TX", "Maricopa County, AZ", "Denver County, CO", "Suffolk County, MA"].map((county) => [county, "Blue"])],
};
let simulation = null;
let current = 0;
let timer = null;
let requestNumber = 0;
let availableCounties = [];
const maxLocations = 12;

function element(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function updateRows() {
  const count = get("locations").children.length;
  get("count").textContent = count + " / " + maxLocations;
  get("add").disabled = count >= maxLocations;
  get("add-random").disabled = !availableCounties.length || count >= maxLocations;
  for (const row of get("locations").children) row.querySelector("button").disabled = count === 1;
}

function addRandomCounties() {
  const rows = get("locations").children;
  const count = Number(get("random-count").value.trim());
  const remaining = maxLocations - rows.length;
  const status = get("random-status");
  if (!Number.isInteger(count) || count < 1 || count > remaining) {
    status.textContent = "Enter a whole number from 1 to " + remaining + ".";
    return;
  }

  const selected = new Set(Array.from(rows, (row) => row.querySelector("input").value.trim()));
  const pool = availableCounties.filter((county) => !selected.has(county));
  if (pool.length < count) {
    status.textContent = "There aren't enough unused counties available.";
    return;
  }
  for (let index = 0; index < count; index++) {
    const draw = Math.floor(Math.random() * pool.length);
    addRow(pool[draw]);
    pool[draw] = pool[pool.length - 1];
    pool.pop();
  }
  get("preset").value = "custom";
  status.textContent = count + (count === 1 ? " county added." : " counties added.");
}

function addRow(county = "", party = "Blue") {
  const row = get("location-template").content.firstElementChild.cloneNode(true);
  row.querySelector("input").value = county;
  row.querySelector("select").value = party;
  row.querySelector("button").onclick = () => {
    row.remove();
    get("preset").value = "custom";
    updateRows();
  };
  get("locations").append(row);
  updateRows();
  return row;
}

function applyPreset(name) {
  const [slots, locations] = presets[name];
  get("slots").value = slots;
  get("locations").replaceChildren();
  locations.forEach(([county, party]) => addRow(county, party));
}

function pause() {
  clearInterval(timer);
  timer = null;
  get("play").textContent = "Play";
}

function render() {
  const frames = simulation?.frames ?? [];
  const frame = frames[current];
  const last = frames.length - 1;
  const final = frame && current === last;
  const diagram = get("diagram");
  const routes = get("routes");
  diagram.replaceChildren();
  routes.replaceChildren();
  for (const field of ["g", "h", "f", "frontier"]) get(field).textContent = frame?.[field] ?? "–";
  get("status").textContent = !simulation ? "Ready" : !frame ? "Infeasible" : final ? "Optimal · " + simulation.cost + " moves" : "Searching";
  get("step").textContent = frame ? (current + 1) + " / " + frames.length : "0 / 0";
  get("scrubber").max = Math.max(last, 0);
  get("scrubber").value = current;
  get("scrubber").disabled = last < 1;
  get("previous").disabled = current <= 0;
  for (const id of ["play", "next", "finish"]) get(id).disabled = current >= last;
  get("event").textContent = !simulation ? "Run a scenario to start the replay." : !frame
    ? "The search stopped before the queue was created. The hub budget cannot cover all starting locations."
    : final ? "A* removed a complete assignment from the queue. The actual total travel cost is " + frame.g + "."
    : frame.revisited ? "A* skips this queue entry because it already reached the same state at a lower cost."
    : (simulation.locations.length - frame.remaining.length) + " assigned · " + frame.remaining.length +
      " waiting · " + frame.slots + " hub slots left. A* prefers the smallest g + h.";
  const upcoming = get("upcoming");
  upcoming.replaceChildren();
  if (!final && frame?.upcoming.length) {
    upcoming.append(element("strong", "Queue immediately after this removal"));
    for (const entry of frame.upcoming) {
      upcoming.append(element("span", "f " + entry.f + " · h " + entry.h + " · " + entry.waiting + " waiting"));
    }
  }
  if (frame) {
    frame.groups.forEach(([indices, [hub, party]]) => {
      const cluster = element("div", "", "cluster");
      const starts = element("div", "", "starts");
      const color = party.toLowerCase();
      for (const index of indices) {
        const [county] = simulation.locations[index];
        starts.append(element("div", county, "node " + color));
        const {path} = simulation.routeIndex.get(JSON.stringify([index, hub]));
        const details = element("details", "", "route");
        details.append(element("summary", county + " → " + hub + " · " + (path.length - 1) + " moves"));
        details.append(element("p", path.join(" → ")));
        routes.append(details);
      }
      cluster.append(starts, element("span", "", "connector"), element("div", hub + " · " + party + " hub", "node hub " + color));
      diagram.append(cluster);
    });
  }
  const waiting = frame?.remaining ?? simulation?.locations.map((_, i) => i) ?? [];
  for (const index of waiting) {
    const [county, party] = simulation.locations[index];
    diagram.append(element("div", county + " · " + party, "node free"));
  }
  if (!diagram.children.length) diagram.append(element("p", "County assignments will appear here.", "empty"));
  if (!routes.children.length) routes.append(element("p", "Routes appear as A* assigns groups to hubs.", "empty"));
  countyMap.update(simulation, frame);
}

function seek(index) {
  current = Math.max(0, Math.min(index, (simulation?.frames.length ?? 1) - 1));
  if (current >= (simulation?.frames.length ?? 0) - 1) pause();
  render();
}

async function run() {
  const request = ++requestNumber;
  pause();
  get("run").disabled = true;
  get("status").textContent = "Running A*…";
  try {
    const locations = Array.from(get("locations").children, (row) => [row.querySelector("input").value.trim(), row.querySelector("select").value]);
    const response = await fetch("/api/simulate", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({locations, slots: Number(get("slots").value)}),
    });
    const result = await response.json();
    if (request !== requestNumber) return;
    if (!response.ok) throw new Error(result.error);
    result.routeIndex = new Map(result.routes.map((route) => [JSON.stringify([route.index, route.hub]), route]));
    simulation = result;
    seek(0);
  } catch (error) {
    if (request !== requestNumber) return;
    get("status").textContent = "Run failed";
    get("event").textContent = error.message;
  } finally {
    if (request === requestNumber) get("run").disabled = false;
  }
}

get("scenario").onsubmit = (event) => { event.preventDefault(); run(); };
get("locations").oninput = () => { get("preset").value = "custom"; };
get("slots").onchange = () => { get("preset").value = "custom"; };
get("add").onclick = () => {
  get("preset").value = "custom";
  addRow().querySelector("input").focus();
};
get("add-random").onclick = addRandomCounties;
get("random-count").onkeydown = (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (!get("add-random").disabled) addRandomCounties();
};
get("preset").onchange = () => { applyPreset(get("preset").value); run(); };
get("scrubber").oninput = () => { pause(); seek(Number(get("scrubber").value)); };
get("previous").onclick = () => { pause(); seek(current - 1); };
get("next").onclick = () => { pause(); seek(current + 1); };
get("finish").onclick = () => { pause(); seek(simulation.frames.length - 1); };
get("play").onclick = () => {
  if (timer) { pause(); return; }
  get("play").textContent = "Pause";
  timer = setInterval(() => seek(current + 1), Number(get("speed").value));
};
get("speed").onchange = () => {
  if (timer) { pause(); get("play").click(); }
};

applyPreset("handout");
render();
run();
fetch("/api/counties").then((response) => {
  if (!response.ok) throw new Error("County list unavailable");
  return response.json();
}).then((counties) => {
  availableCounties = counties;
  get("county-list").replaceChildren(...counties.map((county) => {
    const option = document.createElement("option");
    option.value = county;
    return option;
  }));
  updateRows();
  get("random-status").textContent = "";
}).catch(() => { get("random-status").textContent = "Could not load counties for random selection."; });
