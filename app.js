const $ = (id) => document.getElementById(id);

const permissionStatus = $("permissionStatus");
const refreshPermission = $("refreshPermission");
const scanButton = $("scanButton");
const stopButton = $("stopButton");
const clearButton = $("clearButton");
const resultsBody = $("results");
const progress = $("progress");
const deviceFrame = $("deviceFrame");

// Chrome has shipped this permission under two names; try both.
const PERMISSION_NAMES = ["local-network", "local-network-access"];

// Chrome only surfaces its Local Network Access prompt when the page actually
// attempts a local network request — the Permissions API can query the grant
// but cannot ask for it. Any private address does the job: the grant is scoped
// to this site rather than to the target, and the prompt fires on the attempt
// whether or not anything is listening.
const PERMISSION_PROBE_URL = "http://192.168.1.1/";

let stopRequested = false;
const activeControllers = new Set();

function validateSubnet(value) {
  const parts = value.trim().split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function parsePorts(value) {
  const ports = [...new Set(
    value.split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v >= 1 && v <= 65535)
  )];

  if (!ports.length) {
    throw new Error("Enter at least one valid TCP port.");
  }
  if (ports.length > 10) {
    throw new Error("10 port limit");
  }
  return ports;
}

function showPermission(state, text) {
  permissionStatus.textContent = text;
  return state;
}

async function queryPermission() {
  if (!window.isSecureContext) {
    return showPermission("unavailable", "Unavailable. Page is not a secure context");
  }

  if (!navigator.permissions?.query) {
    return showPermission("unknown", "Permissions API unavailable");
  }

  for (const name of PERMISSION_NAMES) {
    let result;
    try {
      result = await navigator.permissions.query({ name });
    } catch {
      continue; // This Chrome build does not recognize this permission name.
    }

    result.onchange = () =>
      showPermission(result.state, `${result.state} (${name})`);
    return showPermission(result.state, `${result.state} (${name})`);
  }

  return showPermission("unknown", "Not queryable in this browser");
}

async function requestPermission() {
  const state = await queryPermission();

  // "granted" needs nothing, "denied" will not re-prompt, and "unavailable"
  // means an insecure context where the permission does not apply.
  if (state !== "prompt" && state !== "unknown") {
    return state;
  }

  permissionStatus.textContent = "Requesting…";

  try {
    // Deliberately not aborted on a timer: while Chrome's prompt is open the
    // request sits pending, and cancelling it would take the prompt down with
    // it. The onchange handler registered by queryPermission keeps the status
    // display live in the meantime.
    await fetch(PERMISSION_PROBE_URL, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store"
    });
  } catch {
    // Expected — nothing needs to answer for the prompt to have been shown.
  }

  return queryPermission();
}

function permissionBlockedMessage(state) {
  const viaSettings =
    "Open Chrome's site settings for this page (the icon to the left of the " +
    "address bar), set Local network access to Allow, then use Refresh status " +
    "and scan again.";

  if (state === "denied") {
    return `Local network access is blocked for this site, so the scan did not start.\n\n${viaSettings}`;
  }
  if (state === "prompt") {
    return "Local network access has not been granted for this site yet, so " +
      "the scan did not start.\n\nReload the page to bring Chrome's permission " +
      `prompt back, or grant it yourself: ${viaSettings}`;
  }
  return `Local network access could not be confirmed as granted for this site, so the scan did not start.\n\n${viaSettings}`;
}

function protocolForPort(port) {
  return [443, 8443, 9443].includes(port) ? "https" : "http";
}

async function probe(ip, port, timeoutMs) {
  const protocol = protocolForPort(port);
  const url = `${protocol}://${ip}:${port}/`;
  const controller = new AbortController();
  activeControllers.add(controller);

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal
    });

    return {
      ip,
      port,
      protocol,
      reachable: true,
      elapsed: Math.round(performance.now() - started)
    };
  } catch {
    return {
      ip,
      port,
      protocol,
      reachable: false,
      elapsed: Math.round(performance.now() - started)
    };
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

function addResult(result) {
  const empty = $("emptyRow");
  if (empty) empty.remove();

  const row = document.createElement("tr");

  const ip = document.createElement("td");
  ip.textContent = result.ip;

  const port = document.createElement("td");
  port.textContent = String(result.port);

  const protocol = document.createElement("td");
  protocol.textContent = result.protocol.toUpperCase();

  const state = document.createElement("td");

  const badge = document.createElement("span");
  badge.textContent = "Available";

  state.appendChild(badge);

  const elapsed = document.createElement("td");
  elapsed.textContent = `${result.elapsed} ms`;


  // Web interface button
  const webInterface = document.createElement("td");

  const openButton = document.createElement("button");
  openButton.textContent = "Open";

  openButton.addEventListener("click", () => {

    const url =
      `${result.protocol}://${result.ip}:${result.port}/`;

    deviceFrame.src = url;

  });

  webInterface.appendChild(openButton);


  row.append(
    ip,
    port,
    protocol,
    state,
    elapsed,
    webInterface
  );

  resultsBody.appendChild(row);
}

function clearResults() {
  resultsBody.innerHTML = `
    <tr id="emptyRow">
      <td colspan="6" class="empty">No responsive services found yet.</td>
    </tr>`;

  progress.textContent = "No scan started.";
  deviceFrame.src = "about:blank";
}

async function runPool(tasks, concurrency, onResult) {
  let nextIndex = 0;

  async function worker() {
    while (!stopRequested) {
      const index = nextIndex++;
      if (index >= tasks.length) return;

      const result = await tasks[index]();
      onResult(result);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );

  await Promise.all(workers);
}

async function startScan() {
  stopRequested = false;

  if (!window.isSecureContext) {
    alert("Host this page over HTTPS. Chrome's Local Network Access permission is restricted to secure contexts.");
    return;
  }

  // Re-check at click time: the permission may have changed since page load.
  // The button stays disabled for the duration so a second click cannot slip
  // through while the query is in flight.
  scanButton.disabled = true;
  const permission = await queryPermission();
  scanButton.disabled = false;

  if (permission !== "granted") {
    alert(permissionBlockedMessage(permission));
    return;
  }

  const subnet = $("subnet").value.trim();
  const first = Number($("startHost").value);
  const last = Number($("endHost").value);
  const timeoutMs = Number($("timeout").value);
  const concurrency = Number($("concurrency").value);

  if (!validateSubnet(subnet)) {
    alert("Subnet must look like 192.168.1");
    return;
  }

  if (!Number.isInteger(first) || !Number.isInteger(last) ||
      first < 1 || last > 254 || first > last) {
    alert("Choose a host range from 1 through 254.");
    return;
  }

  if (last - first + 1 > 254) {
    alert("This demo is limited to one /24 subnet.");
    return;
  }

  let ports;
  try {
    ports = parsePorts($("ports").value);
  } catch (error) {
    alert(error.message);
    return;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 10000) {
    alert("Timeout must be between 250 and 10000 ms.");
    return;
  }

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 30) {
    alert("Concurrency must be between 1 and 30.");
    return;
  }

  clearResults();
  scanButton.disabled = true;
  stopButton.disabled = false;

  const tasks = [];
  for (let host = first; host <= last; host++) {
    const ip = `${subnet}.${host}`;
    for (const port of ports) {
      tasks.push(() => probe(ip, port, timeoutMs));
    }
  }

  let completed = 0;
  let reachable = 0;
  progress.textContent =
    `Starting ${tasks.length} connection probes.`;

  try {
    await runPool(tasks, concurrency, (result) => {
      completed++;
      if (result.reachable) {
        reachable++;
        addResult(result);
      }

      progress.textContent =
        `${completed}/${tasks.length} probes completed — ${reachable} reachable service${reachable === 1 ? "" : "s"} found.`;
    });
  } finally {
    scanButton.disabled = false;
    stopButton.disabled = true;
    await queryPermission();

    if (stopRequested) {
      progress.textContent += " Scan stopped.";
    } else if (!reachable) {
      progress.textContent +=
        " No selected HTTP/HTTPS services responded; this does not mean no devices exist.";
    }
  }
}

function stopScan() {
  stopRequested = true;
  for (const controller of activeControllers) {
    controller.abort();
  }
  activeControllers.clear();
  stopButton.disabled = true;
}

scanButton.addEventListener("click", startScan);
stopButton.addEventListener("click", stopScan);
clearButton.addEventListener("click", clearResults);
refreshPermission.addEventListener("click", queryPermission);

requestPermission();
