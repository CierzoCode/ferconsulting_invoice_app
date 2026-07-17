"use strict";

const sim = {
  powered: false,
  booting: false,
  wifiConnected: false,
  wifiConnecting: false,
  running: false,
  loopTimer: null,
  startedAt: null,
  lastSampleAt: null,
  packetsSent: 0,
  packetsFailed: 0,
  sequence: 0,
  lastLatencyMs: null,
  latitude: 41.6488,
  longitude: -0.8891,
  toastTimer: null,
  statusTimer: null,
  currentSample: null,
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const fmt = (value, digits = 1) => new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(Number(value) || 0);

function elapsedClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function showToast(message, error = false) {
  const toast = $("simToast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(sim.toastTimer);
  sim.toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function serialTime() {
  const now = new Date();
  return now.toLocaleTimeString("es-ES", { hour12: false }) + `.${String(now.getMilliseconds()).padStart(3, "0")}`;
}

function log(message, level = "info") {
  const monitor = $("serialMonitor");
  const line = document.createElement("div");
  line.className = `serial-line ${level}`;
  line.textContent = `[${serialTime()}] ${message}`;
  monitor.appendChild(line);
  while (monitor.children.length > 240) monitor.removeChild(monitor.firstChild);
  monitor.scrollTop = monitor.scrollHeight;
}

async function jsonFetch(url, options = {}) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const latency = Math.round(performance.now() - started);
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    payload = { ok: false, error: `Respuesta no JSON (${response.status})` };
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    error.latency = latency;
    throw error;
  }
  return { payload, status: response.status, latency };
}

function getScenario() {
  return $("scenarioSelect").value;
}

function inputState() {
  return {
    pressure1: number($("pressure1Input").value, 10),
    pressure2: number($("pressure2Input").value, 9.8),
    flow: number($("flowInput").value, 22),
    speed: number($("speedInput").value, 5.5),
    pressureMax: Math.max(1, number($("pressureMaxInput").value, 25)),
    shunt: Math.max(1, number($("shuntInput").value, 150)),
    pulsesPerLiter: Math.max(1, number($("pulsesPerLiterInput").value, 450)),
    intervalMs: clamp(number($("sendIntervalInput").value, 1000), 250, 10000),
    rssi: clamp(number($("rssiInput").value, -58), -95, -30),
    heading: ((number($("headingInput").value, 35) % 360) + 360) % 360,
    pump: $("pumpSwitch").checked,
    branch1: $("branch1Switch").checked,
    branch2: $("branch2Switch").checked,
    gps: $("gpsSwitch").checked,
    wifi: $("wifiSwitch").checked,
    noise: $("noiseSwitch").checked,
  };
}

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function applyScenario(base) {
  const out = { ...base };
  switch (getScenario()) {
    case "filter_blocked":
      out.pressure1 = Math.min(out.pressureMax, out.pressure1 + 3.2);
      out.pressure2 = Math.max(0, out.pressure2 - 2.4);
      out.flow *= 0.56;
      break;
    case "branch_blocked":
      out.pressure2 = Math.max(0, out.pressure2 * 0.28);
      out.flow *= 0.68;
      break;
    case "pump_failure":
      out.pressure1 *= 0.12;
      out.pressure2 *= 0.1;
      out.flow *= 0.08;
      break;
    case "stopped_with_flow":
      out.speed = 0.1;
      out.flow = Math.max(5, out.flow);
      break;
    case "gps_loss":
      out.gps = false;
      break;
    case "wifi_loss":
      out.wifi = false;
      break;
    default:
      break;
  }
  return out;
}

function pressureElectronics(pressureBar, pressureMax, shunt) {
  const currentMa = clamp(4 + (pressureBar / pressureMax) * 16, 0, 24);
  const voltage = currentMa / 1000 * shunt;
  const adc = Math.round(clamp(voltage / 3.3 * 4095, 0, 4095));
  return { currentMa, voltage, adc };
}

function createSample(dtMs = 1000, advanceGps = true, withNoise = true) {
  let values = applyScenario(inputState());

  if (!values.pump) {
    values.pressure1 = 0;
    values.pressure2 = 0;
    values.flow = 0;
  }
  if (!values.branch1) values.pressure1 = 0;
  if (!values.branch2) values.pressure2 = 0;
  if (!values.branch1 && !values.branch2) values.flow = 0;
  else if (!values.branch1 || !values.branch2) values.flow *= 0.52;

  if (values.noise && withNoise) {
    values.pressure1 = Math.max(0, values.pressure1 + gaussian() * 0.09);
    values.pressure2 = Math.max(0, values.pressure2 + gaussian() * 0.09);
    values.flow = Math.max(0, values.flow + gaussian() * Math.max(0.04, values.flow * 0.008));
    values.speed = Math.max(0, values.speed + gaussian() * 0.025);
  }

  const dtSeconds = Math.max(0, dtMs / 1000);
  if (advanceGps && values.gps && values.speed > 0) {
    const distanceM = values.speed / 3.6 * dtSeconds;
    const headingRad = values.heading * Math.PI / 180;
    sim.latitude += (distanceM * Math.cos(headingRad)) / 111320;
    const lonScale = 111320 * Math.max(0.1, Math.cos(sim.latitude * Math.PI / 180));
    sim.longitude += (distanceM * Math.sin(headingRad)) / lonScale;
  }

  const p1 = pressureElectronics(values.pressure1, values.pressureMax, values.shunt);
  const p2 = pressureElectronics(values.pressure2, values.pressureMax, values.shunt);
  const pulses = Math.round(values.flow * values.pulsesPerLiter * dtSeconds / 60);
  const payload = {
    timestamp: new Date().toISOString(),
    pressure_1_bar: Number(values.pressure1.toFixed(2)),
    pressure_2_bar: Number(values.pressure2.toFixed(2)),
    flow_l_min: Number(values.flow.toFixed(2)),
    speed_kmh: Number(values.speed.toFixed(2)),
    source: "esp32-simulator",
    device_id: "ESP32-ATOM-001",
    sequence: sim.sequence + 1,
  };
  if (values.gps) {
    payload.latitude = Number(sim.latitude.toFixed(7));
    payload.longitude = Number(sim.longitude.toFixed(7));
  }

  return { values, p1, p2, pulses, payload };
}

function updateInputLabels() {
  $("pressure1Output").textContent = `${fmt($("pressure1Input").value, 1)} bar`;
  $("pressure2Output").textContent = `${fmt($("pressure2Input").value, 1)} bar`;
  $("flowOutput").textContent = `${fmt($("flowInput").value, 1)} L/min`;
  $("speedOutput").textContent = `${fmt($("speedInput").value, 1)} km/h`;
  $("intervalText").textContent = `${Math.round(number($("sendIntervalInput").value, 1000))} ms`;
}

function renderSample(sample) {
  sim.currentSample = sample;
  $("nodeP1").textContent = `${fmt(sample.values.pressure1, 1)} bar`;
  $("nodeP2").textContent = `${fmt(sample.values.pressure2, 1)} bar`;
  $("nodeFlow").textContent = `${fmt(sample.values.flow, 1)} L/min`;
  $("nodeGps").textContent = sample.values.gps
    ? `${sample.payload.latitude.toFixed(5)}, ${sample.payload.longitude.toFixed(5)}`
    : "Sin posición";

  $("p1CurrentText").textContent = fmt(sample.p1.currentMa, 2);
  $("p1VoltageText").textContent = fmt(sample.p1.voltage, 3);
  $("p1AdcText").textContent = String(sample.p1.adc);
  $("p2CurrentText").textContent = fmt(sample.p2.currentMa, 2);
  $("p2VoltageText").textContent = fmt(sample.p2.voltage, 3);
  $("p2AdcText").textContent = String(sample.p2.adc);
  $("flowPulsesText").textContent = `${sample.pulses} pulsos`;

  const text = JSON.stringify(sample.payload, null, 2);
  $("payloadPreview").textContent = text;
  $("payloadBytesText").textContent = `${new Blob([text]).size} bytes`;
}

function setBoardVisual() {
  const board = $("espBoard");
  const badge = $("boardRunBadge");
  const wifiChip = $("wifiChip");

  board.classList.toggle("off", !sim.powered);
  board.querySelector(".led-power").classList.toggle("on", sim.powered);
  badge.className = "device-badge";
  if (!sim.powered) {
    badge.textContent = "OFF";
  } else if (sim.booting) {
    badge.textContent = "BOOT";
    badge.classList.add("booting");
  } else if (sim.running) {
    badge.textContent = "RUN";
    badge.classList.add("running");
  } else {
    badge.textContent = "IDLE";
    badge.classList.add("running");
  }

  wifiChip.className = "wifi-chip";
  if (sim.wifiConnecting) {
    wifiChip.textContent = "CONECTANDO";
    wifiChip.classList.add("connecting");
  } else if (sim.wifiConnected) {
    wifiChip.textContent = "ONLINE";
    wifiChip.classList.add("online");
  } else {
    wifiChip.textContent = "OFFLINE";
    wifiChip.classList.add("offline");
  }

  $("boardStateText").textContent = !sim.powered ? "Apagada" : sim.running ? "Ejecutando" : sim.booting ? "Arrancando" : "En espera";
  $("wifiStateText").textContent = sim.wifiConnecting ? "Conectando…" : sim.wifiConnected ? `Conectado · ${$("ssidInput").value}` : "Desconectado";
  $("packetsSentText").textContent = String(sim.packetsSent);
  $("packetsFailedText").textContent = String(sim.packetsFailed);
  $("latencyText").textContent = sim.lastLatencyMs === null ? "—" : `${sim.lastLatencyMs} ms`;
  $("rssiText").textContent = sim.wifiConnected ? `${inputState().rssi} dBm` : "— dBm";
  $("sequenceText").textContent = String(sim.sequence);
  $("uptimeText").textContent = sim.startedAt ? elapsedClock(Date.now() - sim.startedAt) : "00:00:00";

  $("bootButton").textContent = sim.powered ? "Placa encendida" : "Encender placa";
  $("bootButton").disabled = sim.powered || sim.booting;
  $("startSimButton").disabled = sim.running || sim.booting;
  $("stopSimButton").disabled = !sim.running;
}

function flashDataLed() {
  const board = $("espBoard");
  const led = board.querySelector(".led-data");
  board.classList.add("transmitting");
  led.classList.add("on");
  setTimeout(() => {
    board.classList.remove("transmitting");
    led.classList.remove("on");
  }, 150);
}

async function checkServerAndSession() {
  try {
    const { payload } = await jsonFetch("/api/status");
    const badge = $("simServerBadge");
    badge.className = "status-badge status-ok";
    badge.querySelector("span:last-child").textContent = "Servidor Flask conectado";
    $("sessionStateText").textContent = payload.session ? payload.session.parcel : "Sin tratamiento";
    return payload;
  } catch (error) {
    const badge = $("simServerBadge");
    badge.className = "status-badge status-error";
    badge.querySelector("span:last-child").textContent = "Servidor no disponible";
    $("sessionStateText").textContent = "Sin conexión";
    return null;
  }
}

async function ensureSession() {
  const status = await checkServerAndSession();
  if (!status) throw new Error("No se puede contactar con Flask");
  if (status.session) return status.session;
  if (!$("autoSessionCheckbox").checked) {
    throw new Error("No hay tratamiento activo. Inícialo en el panel principal.");
  }

  const settings = status.settings || {};
  const body = {
    parcel: "Parcela simulador ESP32",
    product: "Agua de prueba",
    operator: "Placa virtual ESP32",
    tank_initial_l: settings.tank_capacity_l || 600,
    work_width_m: settings.work_width_m || 8,
    target_l_ha: settings.target_l_ha || 300,
    target_pressure_bar: settings.target_pressure_bar || 10,
  };
  const { payload } = await jsonFetch("/api/session/start", { method: "POST", body: JSON.stringify(body) });
  log(`Tratamiento de simulación creado. ID ${payload.session_id}`, "ok");
  await checkServerAndSession();
  return payload;
}

async function bootBoard() {
  if (sim.powered || sim.booting) return;
  sim.booting = true;
  sim.startedAt = Date.now();
  setBoardVisual();
  log("ets Jun  8 2016 00:22:57", "info");
  await sleep(180);
  log("rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)", "info");
  await sleep(240);
  log("load:0x3fff0030,len:1344", "info");
  log("load:0x40078000,len:13964", "info");
  await sleep(300);
  log("entry 0x400806f0", "info");
  await sleep(350);
  sim.powered = true;
  sim.booting = false;
  sim.latitude = number($("latitudeInput").value, 41.6488);
  sim.longitude = number($("longitudeInput").value, -0.8891);
  log("Atomizador ESP32 firmware v1.1", "ok");
  log("ADC 12-bit configurado · atenuación 11 dB", "info");
  log(`Caudalímetro: ${Math.round(inputState().pulsesPerLiter)} pulsos/L`, "info");
  setBoardVisual();
  renderSample(createSample(0, false, false));
  if (inputState().wifi) await connectWiFi();
}

async function connectWiFi() {
  if (!sim.powered) {
    await bootBoard();
    if (sim.wifiConnected) return;
  }
  if (sim.wifiConnecting || sim.wifiConnected) return;
  const values = applyScenario(inputState());
  if (!values.wifi) {
    sim.wifiConnected = false;
    setBoardVisual();
    log("WiFi deshabilitado o escenario de pérdida de red", "warn");
    return;
  }

  sim.wifiConnecting = true;
  sim.wifiConnected = false;
  setBoardVisual();
  const ssid = $("ssidInput").value.trim() || "ATOMIZADOR_TRACTOR";
  log(`Conectando a WiFi SSID «${ssid}»`, "info");
  for (let i = 0; i < 3; i += 1) {
    await sleep(320);
    log(".", "info");
  }
  sim.wifiConnecting = false;
  sim.wifiConnected = true;
  setBoardVisual();
  log(`WiFi conectado · IP 192.168.4.${100 + Math.floor(Math.random() * 70)} · RSSI ${inputState().rssi} dBm`, "ok");
}

function scheduleNextLoop() {
  clearTimeout(sim.loopTimer);
  if (!sim.running) return;
  sim.loopTimer = setTimeout(runLoop, inputState().intervalMs);
}

async function runLoop() {
  if (!sim.running) return;
  await transmitSample();
  scheduleNextLoop();
}

async function transmitSample() {
  if (!sim.powered) await bootBoard();
  const now = Date.now();
  const dtMs = sim.lastSampleAt ? clamp(now - sim.lastSampleAt, 1, 10000) : inputState().intervalMs;
  sim.lastSampleAt = now;
  const sample = createSample(dtMs, true, true);
  renderSample(sample);
  sim.sequence += 1;
  sample.payload.sequence = sim.sequence;
  renderSample(sample);
  setBoardVisual();

  const values = applyScenario(inputState());
  if (!values.wifi) {
    if (sim.wifiConnected) log("WiFi desconectado por el escenario activo", "warn");
    sim.wifiConnected = false;
  }
  if (!sim.wifiConnected) {
    sim.packetsFailed += 1;
    $("httpStatusBadge").className = "http-badge error";
    $("httpStatusBadge").textContent = "SIN RED";
    $("responsePreview").textContent = "Paquete no enviado: la placa no tiene conexión WiFi.";
    log(`Paquete #${sim.sequence} descartado: WL_DISCONNECTED`, "error");
    setBoardVisual();
    return;
  }

  const url = $("apiUrlInput").value.trim() || "/api/telemetry";
  const headers = {};
  const apiKey = $("apiKeyInput").value.trim();
  if (apiKey) headers["X-API-Key"] = apiKey;
  flashDataLed();
  log(`POST ${url} · paquete #${sim.sequence} · ${new Blob([JSON.stringify(sample.payload)]).size} bytes`, "http");
  try {
    const result = await jsonFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(sample.payload),
    });
    sim.packetsSent += 1;
    sim.lastLatencyMs = result.latency;
    $("httpStatusBadge").className = "http-badge ok";
    $("httpStatusBadge").textContent = `HTTP ${result.status}`;
    $("responsePreview").textContent = JSON.stringify(result.payload, null, 2);
    const calc = result.payload.calculated || {};
    log(`HTTP ${result.status} OK · ${result.latency} ms · ${fmt(calc.l_ha, 0)} L/ha`, "ok");
  } catch (error) {
    sim.packetsFailed += 1;
    sim.lastLatencyMs = error.latency ?? null;
    $("httpStatusBadge").className = "http-badge error";
    $("httpStatusBadge").textContent = error.status ? `HTTP ${error.status}` : "ERROR";
    $("responsePreview").textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
    log(`Fallo HTTP: ${error.message}`, "error");
  }
  setBoardVisual();
}

async function startSimulation() {
  try {
    if (!sim.powered) await bootBoard();
    await ensureSession();
    if (!sim.wifiConnected) await connectWiFi();
    if (!sim.wifiConnected) throw new Error("La placa no tiene conexión WiFi");
    sim.running = true;
    sim.lastSampleAt = null;
    setBoardVisual();
    log(`Loop iniciado · intervalo ${inputState().intervalMs} ms`, "ok");
    showToast("Simulación ESP32 iniciada");
    await transmitSample();
    scheduleNextLoop();
  } catch (error) {
    log(error.message, "error");
    showToast(error.message, true);
  }
}

function stopSimulation() {
  sim.running = false;
  clearTimeout(sim.loopTimer);
  sim.loopTimer = null;
  setBoardVisual();
  log("Loop detenido por el usuario", "warn");
  showToast("Simulación detenida");
}

async function resetSimulation() {
  stopSimulation();
  sim.powered = false;
  sim.booting = false;
  sim.wifiConnected = false;
  sim.wifiConnecting = false;
  sim.startedAt = null;
  sim.lastSampleAt = null;
  sim.sequence = 0;
  sim.latitude = number($("latitudeInput").value, 41.6488);
  sim.longitude = number($("longitudeInput").value, -0.8891);
  setBoardVisual();
  renderSample(createSample(0, false, false));
  log("rst:0xc (SW_CPU_RESET)", "warn");
  await sleep(250);
  await bootBoard();
}

async function sendOnce() {
  try {
    if (!sim.powered) await bootBoard();
    await ensureSession();
    if (!sim.wifiConnected) await connectWiFi();
    await transmitSample();
  } catch (error) {
    log(error.message, "error");
    showToast(error.message, true);
  }
}

function scenarioChanged() {
  const value = getScenario();
  const labels = {
    normal: "Trabajo normal",
    filter_blocked: "Filtro obstruido: presión antes del filtro alta y caudal reducido",
    branch_blocked: "Ramal 2 obstruido: diferencia de presiones",
    pump_failure: "Fallo de bomba: presión y caudal casi nulos",
    stopped_with_flow: "Vehículo parado con salida de producto",
    gps_loss: "El módulo GPS deja de entregar posición",
    wifi_loss: "La placa pierde la red y acumula errores de envío",
  };
  log(`Escenario: ${labels[value]}`, value === "normal" ? "info" : "warn");
  if (value === "wifi_loss") {
    sim.wifiConnected = false;
  } else if (sim.powered && inputState().wifi && !sim.wifiConnected && !sim.wifiConnecting) {
    connectWiFi();
  }
  renderSample(createSample(0, false, false));
  setBoardVisual();
}

function bindInputs() {
  ["pressure1Input", "pressure2Input", "flowInput", "speedInput", "pressureMaxInput", "shuntInput", "pulsesPerLiterInput", "sendIntervalInput", "rssiInput", "headingInput"].forEach((id) => {
    $(id).addEventListener("input", () => {
      updateInputLabels();
      renderSample(createSample(0, false, false));
      setBoardVisual();
    });
  });
  ["pumpSwitch", "branch1Switch", "branch2Switch", "gpsSwitch", "wifiSwitch", "noiseSwitch"].forEach((id) => {
    $(id).addEventListener("change", async () => {
      if (id === "wifiSwitch") {
        if (!$(id).checked) {
          sim.wifiConnected = false;
          log("WiFi deshabilitado desde el interruptor", "warn");
        } else if (sim.powered) {
          await connectWiFi();
        }
      }
      renderSample(createSample(0, false, false));
      setBoardVisual();
    });
  });
  $("latitudeInput").addEventListener("change", () => { sim.latitude = number($("latitudeInput").value, sim.latitude); });
  $("longitudeInput").addEventListener("change", () => { sim.longitude = number($("longitudeInput").value, sim.longitude); });
}

function bindEvents() {
  $("bootButton").addEventListener("click", bootBoard);
  $("startSimButton").addEventListener("click", startSimulation);
  $("stopSimButton").addEventListener("click", stopSimulation);
  $("connectWifiButton").addEventListener("click", connectWiFi);
  $("sendOnceButton").addEventListener("click", sendOnce);
  $("resetSimButton").addEventListener("click", resetSimulation);
  $("scenarioSelect").addEventListener("change", scenarioChanged);
  $("clearLogButton").addEventListener("click", () => { $("serialMonitor").innerHTML = ""; });
  bindInputs();
}

async function init() {
  $("apiUrlInput").value = `${window.location.origin}/api/telemetry`;
  updateInputLabels();
  bindEvents();
  setBoardVisual();
  renderSample(createSample(0, false, false));
  await checkServerAndSession();
  sim.statusTimer = setInterval(() => {
    checkServerAndSession();
    setBoardVisual();
  }, 2000);
}

document.addEventListener("DOMContentLoaded", init);
