const $ = (id) => document.getElementById(id);

const permissionStatus = $("permissionStatus");
const refreshPermission = $("refreshPermission");
const scanButton = $("scanButton");
const stopButton = $("stopButton");
const clearButton = $("clearButton");
const resultsBody = $("results");
const progress = $("progress");

let stopRequested = false;
let activeControllers = new Set();

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

async function queryPermission() {
  if (!window.isSecureContext) {
    permissionStatus.textContent = "Unavailable. Page is not a secure context";
    return "unavailable";
  }

  if (!navigator.permissions?.query) {
    permissionStatus.textContent = "Permissions API unavailable";
    return "unknown";
  }

  for (const name of ["local-network", "local-network-access"]) {
    try {
      const result = await navigator.permissions.query({ name });
      permissionStatus.textContent = `${result.state} (${name})`;
      result.onchange = () => {
        permissionStatus.textContent = `${result.state} (${name})`;
      };
      return result.state;
    } catch (_) {

    }
  }

  permissionStatus.textContent =
    "Not queryable here a local request may still trigger Chrome's prompt";
  return "unknown";
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
  } catch (error) {
    return {
      ip,
      port,
      protocol,
      reachable: false,
      elapsed: Math.round(performance.now() - started),
      error: error?.name || "NetworkError"
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
  badge.className = "badge";
  badge.textContent = "Connection completed";
  state.appendChild(badge);

  const elapsed = document.createElement("td");
  elapsed.textContent = `${result.elapsed} ms`;

  row.append(ip, port, protocol, state, elapsed);
  resultsBody.appendChild(row);
}

function clearResults() {
  resultsBody.innerHTML = `
    <tr id="emptyRow">
      <td colspan="5" class="empty">No responsive services found yet.</td>
    </tr>`;
  progress.textContent = "No scan started.";
}

async function runPool(tasks, concurrency, onResult) {
  let nextIndex = 0;

  async function worker() {
    while (!stopRequested) {
      const index = nextIndex++;
      if (index >= tasks.length) return;

      const result = await tasks[index]();
      onResult(result, index);
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

  const subnet = $("subnet").value.trim();
  const first = Number($("startHost").value);
  const last = Number($("endHost").value);
  const timeoutMs = Number($("timeout").value);
  const concurrency = Number($("concurrency").value);

  if (!window.isSecureContext) {
    alert("Host this page over HTTPS. Chrome's Local Network Access permission is restricted to secure contexts.");
    return;
  }

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

queryPermission();
