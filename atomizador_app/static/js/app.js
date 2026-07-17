"use strict";

const state = {
  status: null,
  pollTimer: null,
  demoTimer: null,
  toastTimer: null,
  isPolling: false,
  gpsWatchId: null,
  lastGps: null,
};

const byId = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const preciseFormat = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

function formatNumber(value, digits = 1, fallback = "—") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function showToast(message, error = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3300);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = { ok: false, error: `Respuesta no válida (${response.status})` };
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Error HTTP ${response.status}`);
  }
  return payload;
}

function setConnection(connected) {
  const badge = byId("connectionBadge");
  badge.className = `status-badge ${connected ? "status-ok" : "status-error"}`;
  badge.querySelector("span:last-child").textContent = connected ? "Servidor conectado" : "Sin conexión";
}

function setGpsState(kind, message) {
  const badge = byId("gpsBadge");
  badge.className = `status-badge ${kind === "ok" ? "status-ok" : kind === "error" ? "status-error" : "status-muted"}`;
  badge.querySelector("span:last-child").textContent = message;
}

function distanceMeters(a, b) {
  const radius = 6371000;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

async function sendDevicePosition(position) {
  const coords = position.coords;
  let speedKmh = Number.isFinite(coords.speed) && coords.speed >= 0 ? coords.speed * 3.6 : 0;
  const current = { latitude: coords.latitude, longitude: coords.longitude, timestamp: position.timestamp };
  if (!(speedKmh > 0) && state.lastGps) {
    const seconds = (current.timestamp - state.lastGps.timestamp) / 1000;
    const distance = distanceMeters(state.lastGps, current);
    if (seconds > 0.5 && seconds < 15 && distance > Math.max(1.5, Number(coords.accuracy || 0) * 0.15)) {
      speedKmh = Math.min(100, distance / seconds * 3.6);
    }
  }
  state.lastGps = current;
  try {
    await api("/api/device-location", {
      method: "POST",
      body: JSON.stringify({
        latitude: coords.latitude,
        longitude: coords.longitude,
        speed_kmh: speedKmh,
        accuracy_m: coords.accuracy,
      }),
    });
    setGpsState("ok", `GPS dispositivo · ±${Math.round(coords.accuracy)} m`);
  } catch (error) {
    setGpsState("error", "GPS sin enviar");
    console.error(error);
  }
}

function startDeviceGps() {
  if (!navigator.geolocation) {
    setGpsState("error", "GPS no disponible");
    return;
  }
  state.gpsWatchId = navigator.geolocation.watchPosition(
    sendDevicePosition,
    (error) => setGpsState("error", error.code === 1 ? "Permiso GPS denegado" : "Sin señal GPS"),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  );
}

function updateGauge(id, value, maxValue) {
  const ratio = Math.max(0, Math.min(100, (Number(value || 0) / Math.max(1, maxValue)) * 100));
  byId(id).style.width = `${ratio}%`;
}

function updateMetricState(current, session) {
  const pill = byId("lhaState");
  const workState = byId("workState");
  pill.className = "metric-pill";

  if (!current || current.l_ha === null) {
    pill.textContent = "Sin datos";
    workState.textContent = "Esperando movimiento";
    return;
  }

  const target = Number(session?.target_l_ha || 0);
  const deviation = target ? Math.abs((Number(current.l_ha) - target) / target) * 100 : 0;
  if (deviation <= 10) {
    pill.textContent = "Correcto";
    pill.classList.add("good");
  } else {
    pill.textContent = deviation > 20 ? "Desviado" : "Revisar";
    pill.classList.add("warning");
  }
  workState.textContent = current.is_working ? "Aplicando producto" : "Equipo sin aplicar";
}

function renderStatus(data) {
  state.status = data;
  const session = data.session;
  const current = data.current;
  const settings = data.settings || {};
  const active = Boolean(session);

  byId("startSessionButton").classList.toggle("hidden", active);
  byId("stopSessionButton").classList.toggle("hidden", !active);
  byId("demoToggle").disabled = !active;
  if (!active && byId("demoToggle").checked) {
    byId("demoToggle").checked = false;
    stopDemo();
  }

  if (active) {
    byId("sessionTitle").textContent = session.parcel;
    byId("sessionSubtitle").textContent = `${session.product} · ${session.operator}`;
  } else {
    byId("sessionTitle").textContent = "Sin tratamiento activo";
    byId("sessionSubtitle").textContent = "Configura una parcela y pulsa “Iniciar”.";
  }

  byId("lhaValue").textContent = formatNumber(current?.l_ha, 0);
  byId("lhaTarget").textContent = formatNumber(session?.target_l_ha ?? settings.target_l_ha, 0);
  byId("pressure1Value").textContent = formatNumber(current?.pressure_1_bar, 1);
  byId("pressure2Value").textContent = formatNumber(current?.pressure_2_bar, 1);
  byId("flowValue").textContent = formatNumber(current?.flow_l_min, 1);
  byId("speedValue").textContent = formatNumber(current?.speed_kmh, 1);
  byId("averageLhaValue").textContent = formatNumber(session?.average_l_ha, 0);

  const gaugeMax = Math.max(20, Number(session?.target_pressure_bar || settings.target_pressure_bar || 10) * 1.8);
  updateGauge("pressure1Gauge", current?.pressure_1_bar, gaugeMax);
  updateGauge("pressure2Gauge", current?.pressure_2_bar, gaugeMax);
  updateMetricState(current, session);

  const liters = Number(session?.liters_applied || 0);
  const tankInitial = Number(session?.tank_initial_l || settings.tank_capacity_l || 0);
  const remaining = Math.max(0, Number(session?.tank_remaining_l ?? tankInitial - liters));
  const tankPct = tankInitial > 0 ? Math.max(0, Math.min(100, remaining / tankInitial * 100)) : 0;
  byId("tankProgress").style.width = `${tankPct}%`;
  byId("tankText").textContent = active ? `${formatNumber(remaining, 0)} / ${formatNumber(tankInitial, 0)} L` : "—";
  byId("remainingValue").textContent = active ? `${formatNumber(remaining, 1)} L` : "—";
  byId("litersValue").textContent = `${formatNumber(liters, 1, "0,0")} L`;
  byId("areaValue").textContent = `${preciseFormat.format(Number(session?.area_ha || 0))} ha`;
  byId("distanceValue").textContent = `${numberFormat.format(Number(session?.distance_m || 0))} m`;
  byId("workTimeValue").textContent = formatDuration(session?.work_seconds);

  const target = Number(session?.target_l_ha || settings.target_l_ha || 0);
  const currentLha = Number(current?.l_ha);
  const deviation = target > 0 && Number.isFinite(currentLha) ? ((currentLha - target) / target) * 100 : null;
  byId("deviationValue").textContent = deviation === null ? "—" : `${deviation >= 0 ? "+" : ""}${formatNumber(deviation, 1)} %`;

  renderAlarms(data.alarms || []);
  drawHistory(data.recent || [], target);
  drawRoute(data.recent || []);
  renderDriveMode(data);

  const doseTank = byId("doseTank");
  const doseVolume = byId("doseVolume");
  if (doseTank && !doseTank.dataset.initialized) {
    doseTank.value = settings.tank_capacity_l || 600;
    doseVolume.value = settings.target_l_ha || 300;
    doseTank.dataset.initialized = "true";
    calculateDose();
  }
}

function calculateDose() {
  const area = Math.max(0, Number(byId("doseArea").value) || 0);
  const rate = Math.max(0, Number(byId("doseRate").value) || 0);
  const volume = Math.max(0, Number(byId("doseVolume").value) || 0);
  const tank = Math.max(0, Number(byId("doseTank").value) || 0);
  const unit = byId("doseUnit").value;
  const productTotal = area * rate;
  const mixTotal = area * volume;
  const tanks = tank > 0 ? mixTotal / tank : 0;
  const productTank = volume > 0 ? rate * tank / volume : 0;
  const productDigits = unit === "ml" || unit === "g" ? 0 : 2;
  byId("doseProductTotal").textContent = `${formatNumber(productTotal, productDigits, "0")} ${unit}`;
  byId("doseMixTotal").textContent = `${formatNumber(mixTotal, 0, "0")} L`;
  byId("doseTanks").textContent = tanks > 0
    ? `${Math.ceil(tanks)} (${formatNumber(tanks, 2, "0")} depósitos)`
    : "0";
  byId("doseProductTank").textContent = `${formatNumber(productTank, productDigits, "0")} ${unit}`;
}

function renderAlarms(alarms) {
  byId("alarmCount").textContent = String(alarms.length);
  const container = byId("alarmList");
  if (!alarms.length) {
    container.innerHTML = '<div class="empty-list">No hay alarmas activas.</div>';
    return;
  }
  container.innerHTML = alarms.map((alarm) => `
    <div class="alarm-item ${alarm.level === "danger" ? "danger" : "warning"}">
      <span class="alarm-symbol">!</span>
      <span>${escapeHtml(alarm.message)}</span>
    </div>
  `).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawHistory(recent, target) {
  const canvas = byId("historyCanvas");
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);

  const padding = { left: 42, right: 22, top: 18, bottom: 28 };
  const graphW = Math.max(1, width - padding.left - padding.right);
  const graphH = Math.max(1, height - padding.top - padding.bottom);
  const data = recent.filter((item) => item.l_ha !== null || item.pressure_1_bar !== null);

  ctx.font = "10px system-ui";
  ctx.strokeStyle = "rgba(31, 66, 49, .10)";
  ctx.fillStyle = "#75827b";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + graphH * i / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  if (!data.length) {
    ctx.fillStyle = "#7b8981";
    ctx.textAlign = "center";
    ctx.fillText("Esperando telemetría", width / 2, height / 2);
    return;
  }

  const lhaValues = data.map((item) => Number(item.l_ha)).filter(Number.isFinite);
  const pressureValues = data.map((item) => Number(item.pressure_1_bar)).filter(Number.isFinite);
  const lhaMax = Math.max(target * 1.45 || 400, ...lhaValues, 1);
  const pressureMax = Math.max(Number(state.status?.session?.target_pressure_bar || 10) * 1.7, ...pressureValues, 1);
  const xFor = (index) => padding.left + (data.length === 1 ? graphW : graphW * index / (data.length - 1));

  if (target > 0) {
    const yTarget = padding.top + graphH - (target / lhaMax) * graphH;
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "rgba(22, 122, 74, .34)";
    ctx.beginPath();
    ctx.moveTo(padding.left, yTarget);
    ctx.lineTo(width - padding.right, yTarget);
    ctx.stroke();
    ctx.restore();
  }

  function drawSeries(key, max, stroke, fill) {
    const valid = data.map((item, index) => ({ value: Number(item[key]), index })).filter((p) => Number.isFinite(p.value));
    if (!valid.length) return;
    ctx.beginPath();
    valid.forEach((point, idx) => {
      const x = xFor(point.index);
      const y = padding.top + graphH - (point.value / max) * graphH;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    if (fill && valid.length > 1) {
      const last = valid[valid.length - 1];
      const first = valid[0];
      ctx.lineTo(xFor(last.index), padding.top + graphH);
      ctx.lineTo(xFor(first.index), padding.top + graphH);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + graphH);
      gradient.addColorStop(0, fill);
      gradient.addColorStop(1, "rgba(22, 122, 74, 0)");
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  }

  drawSeries("l_ha", lhaMax, "#167a4a", "rgba(22, 122, 74, .18)");
  drawSeries("pressure_1_bar", pressureMax, "#e99d2f", null);

  ctx.fillStyle = "#75827b";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(lhaMax)} L/ha`, padding.left - 7, padding.top + 4);
  ctx.fillText("0", padding.left - 7, padding.top + graphH + 3);
  ctx.textAlign = "left";
  ctx.fillText("-2 min", padding.left, height - 7);
  ctx.textAlign = "right";
  ctx.fillText("ahora", width - padding.right, height - 7);
}

function drawRouteOnCanvas(recent, canvasId, emptyId) {
  const canvas = byId(canvasId);
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const points = recent
    .filter((item) => item.latitude !== null && item.longitude !== null)
    .map((item) => ({ lat: Number(item.latitude), lon: Number(item.longitude), working: Boolean(item.is_working) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  byId(emptyId).classList.toggle("hidden", points.length >= 2);
  if (points.length < 2) return;

  let minLat = Math.min(...points.map((p) => p.lat));
  let maxLat = Math.max(...points.map((p) => p.lat));
  let minLon = Math.min(...points.map((p) => p.lon));
  let maxLon = Math.max(...points.map((p) => p.lon));
  if (maxLat - minLat < 0.00001) { minLat -= 0.000005; maxLat += 0.000005; }
  if (maxLon - minLon < 0.00001) { minLon -= 0.000005; maxLon += 0.000005; }

  const pad = 32;
  const xFor = (lon) => pad + ((lon - minLon) / (maxLon - minLon)) * (width - pad * 2);
  const yFor = (lat) => height - pad - ((lat - minLat) / (maxLat - minLat)) * (height - pad * 2);

  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 9;
  ctx.strokeStyle = "rgba(22,122,74,.12)";
  ctx.beginPath();
  points.forEach((p, index) => index === 0 ? ctx.moveTo(xFor(p.lon), yFor(p.lat)) : ctx.lineTo(xFor(p.lon), yFor(p.lat)));
  ctx.stroke();

  ctx.lineWidth = 3.2;
  ctx.beginPath();
  points.forEach((p, index) => index === 0 ? ctx.moveTo(xFor(p.lon), yFor(p.lat)) : ctx.lineTo(xFor(p.lon), yFor(p.lat)));
  ctx.strokeStyle = "#167a4a";
  ctx.stroke();

  const start = points[0];
  const end = points[points.length - 1];
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#167a4a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(xFor(start.lon), yFor(start.lat), 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#167a4a";
  ctx.beginPath();
  ctx.arc(xFor(end.lon), yFor(end.lat), 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoute(recent) {
  drawRouteOnCanvas(recent, "routeCanvas", "mapEmpty");
  if (!byId("driveMode").classList.contains("hidden")) drawRouteOnCanvas(recent, "driveRouteCanvas", "driveMapEmpty");
}

function setSideButton(id, enabled) {
  const button = byId(id);
  button.classList.toggle("enabled", enabled);
  button.querySelector("strong").textContent = enabled ? "ENCENDIDO" : "APAGADO";
  button.setAttribute("aria-pressed", String(enabled));
}

function renderDriveMode(data) {
  const current = data.current;
  const session = data.session;
  byId("driveSessionTitle").textContent = session?.parcel || "Atomizador";
  byId("driveLha").textContent = formatNumber(current?.l_ha, 0);
  byId("driveSpeed").textContent = formatNumber(current?.speed_kmh, 1);
  byId("driveFlow").textContent = formatNumber(current?.flow_l_min, 1);
  byId("drivePressure").textContent = `${formatNumber(current?.pressure_1_bar, 1)} / ${formatNumber(current?.pressure_2_bar, 1)}`;
  byId("driveTank").textContent = formatNumber(session?.tank_remaining_l, 0);
  const remaining = Number(session?.tank_remaining_l);
  const flow = Number(current?.flow_l_min);
  const autonomyHours = Number.isFinite(remaining) && flow > 0.1 ? remaining / flow / 60 : null;
  byId("driveAutonomy").textContent = autonomyHours === null ? "—" : formatNumber(autonomyHours, 1);
  const tankInput = byId("driveTankInput");
  if (document.activeElement !== tankInput && Number.isFinite(remaining)) tankInput.value = Math.round(remaining);
  const gpsActive = Boolean(data.device_location?.active);
  byId("driveGpsState").textContent = gpsActive ? `GPS ±${Math.round(data.device_location.accuracy_m || 0)} m` : "GPS sin señal";
  byId("driveGpsState").classList.toggle("active", gpsActive);
  setSideButton("leftSideButton", Boolean(data.control?.left_enabled));
  setSideButton("rightSideButton", Boolean(data.control?.right_enabled));
}

async function updateTank(remaining) {
  try {
    await api("/api/session/tank", { method: "POST", body: JSON.stringify({ remaining_l: remaining }) });
    showToast("Nivel del depósito actualizado");
    await pollStatus();
  } catch (error) { showToast(error.message, true); }
}

function submitDriveTank(event) {
  event.preventDefault();
  updateTank(Math.max(0, Number(byId("driveTankInput").value) || 0));
}

function fillDriveTank() {
  const capacity = Number(state.status?.settings?.tank_capacity_l || 0);
  byId("driveTankInput").value = capacity;
  updateTank(capacity);
}

function openDriveMode() {
  byId("driveMode").classList.remove("hidden");
  document.body.classList.add("drive-open");
  renderDriveMode(state.status || {});
  requestAnimationFrame(() => drawRouteOnCanvas(state.status?.recent || [], "driveRouteCanvas", "driveMapEmpty"));
  byId("driveMode").requestFullscreen?.().catch(() => {});
}

function closeDriveMode() {
  byId("driveMode").classList.add("hidden");
  document.body.classList.remove("drive-open");
  if (document.fullscreenElement) document.exitFullscreen?.();
}

async function toggleSide(side) {
  const control = state.status?.control || {};
  const payload = {
    left_enabled: side === "left" ? !control.left_enabled : Boolean(control.left_enabled),
    right_enabled: side === "right" ? !control.right_enabled : Boolean(control.right_enabled),
  };
  try {
    const result = await api("/api/control", { method: "POST", body: JSON.stringify(payload) });
    state.status.control = result;
    renderDriveMode(state.status);
  } catch (error) { showToast(error.message, true); }
}

async function pollStatus() {
  if (state.isPolling) return;
  state.isPolling = true;
  try {
    const data = await api("/api/status");
    setConnection(true);
    renderStatus(data);
  } catch (error) {
    setConnection(false);
    console.error(error);
  } finally {
    state.isPolling = false;
  }
}

function fillForm(form, values) {
  Object.entries(values || {}).forEach(([key, value]) => {
    const field = form.elements.namedItem(key);
    if (field && value !== null && value !== undefined) field.value = value;
  });
}

function formToObject(form) {
  const result = {};
  new FormData(form).forEach((value, key) => {
    const element = form.elements.namedItem(key);
    result[key] = element?.type === "number" ? Number(value) : String(value).trim();
  });
  return result;
}

function openSessionDialog() {
  const settings = state.status?.settings || {};
  const form = byId("sessionForm");
  form.reset();
  fillForm(form, {
    tank_initial_l: settings.tank_capacity_l,
    work_width_m: settings.work_width_m,
    target_l_ha: settings.target_l_ha,
    target_pressure_bar: settings.target_pressure_bar,
  });
  byId("sessionDialog").showModal();
}

async function submitSession(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (event.submitter?.value === "cancel") {
    byId("sessionDialog").close();
    return;
  }
  if (!form.reportValidity()) return;
  try {
    await api("/api/session/start", { method: "POST", body: JSON.stringify(formToObject(form)) });
    byId("sessionDialog").close();
    showToast("Tratamiento iniciado");
    await pollStatus();
    await loadHistory();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function stopSession() {
  if (!window.confirm("¿Finalizar el tratamiento actual? Los datos quedarán guardados.")) return;
  try {
    await api("/api/session/stop", { method: "POST", body: "{}" });
    stopDemo();
    byId("demoToggle").checked = false;
    showToast("Tratamiento finalizado");
    await pollStatus();
    await loadHistory();
  } catch (error) {
    showToast(error.message, true);
  }
}

function openSettingsDialog() {
  const form = byId("settingsForm");
  fillForm(form, state.status?.settings || {});
  byId("settingsDialog").showModal();
}

async function submitSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (event.submitter?.value === "cancel") {
    byId("settingsDialog").close();
    return;
  }
  if (!form.reportValidity()) return;
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify(formToObject(form)) });
    byId("settingsDialog").close();
    showToast("Configuración guardada");
    await pollStatus();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function sendDemoSample() {
  try {
    await api("/api/demo/sample", { method: "POST", body: "{}" });
  } catch (error) {
    stopDemo();
    byId("demoToggle").checked = false;
    showToast(error.message, true);
  }
}

function startDemo() {
  if (state.demoTimer) return;
  sendDemoSample();
  state.demoTimer = setInterval(sendDemoSample, 1000);
  showToast("Simulador activado");
}

function stopDemo() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
}

async function loadHistory() {
  try {
    const data = await api("/api/sessions");
    const container = byId("sessionHistory");
    if (!data.sessions.length) {
      container.innerHTML = '<div class="empty-list">Todavía no hay tratamientos guardados.</div>';
      return;
    }
    container.innerHTML = data.sessions.slice(0, 8).map((session) => `
      <div class="session-row">
        <div class="session-main">
          <strong>${escapeHtml(session.parcel)}</strong>
          <span>${formatDate(session.started_at)} · ${escapeHtml(session.product)}</span>
        </div>
        <div class="session-stat"><strong>${formatNumber(session.area_ha, 3)} ha</strong><span>Superficie</span></div>
        <div class="session-stat"><strong>${formatNumber(session.liters_applied, 1)} L</strong><span>Aplicados</span></div>
        <div class="session-stat"><strong>${formatNumber(session.average_l_ha, 0)}</strong><span>L/ha medio</span></div>
        <a class="export-link" href="/api/session/${session.id}/export.csv">Exportar CSV</a>
      </div>
    `).join("");
  } catch (error) {
    console.error(error);
  }
}

function redrawCanvases() {
  const data = state.status;
  if (!data) return;
  drawHistory(data.recent || [], Number(data.session?.target_l_ha || data.settings?.target_l_ha || 0));
  drawRoute(data.recent || []);
}

function bindEvents() {
  byId("startSessionButton").addEventListener("click", openSessionDialog);
  byId("stopSessionButton").addEventListener("click", stopSession);
  byId("openSettingsButton").addEventListener("click", openSettingsDialog);
  byId("sessionForm").addEventListener("submit", submitSession);
  byId("settingsForm").addEventListener("submit", submitSettings);
  byId("refreshHistoryButton").addEventListener("click", loadHistory);
  byId("demoToggle").addEventListener("change", (event) => event.target.checked ? startDemo() : stopDemo());
  window.addEventListener("resize", redrawCanvases);
  byId("doseForm").addEventListener("input", calculateDose);
  byId("doseForm").addEventListener("submit", (event) => event.preventDefault());
  byId("openDriveModeButton").addEventListener("click", openDriveMode);
  byId("closeDriveModeButton").addEventListener("click", closeDriveMode);
  byId("leftSideButton").addEventListener("click", () => toggleSide("left"));
  byId("rightSideButton").addEventListener("click", () => toggleSide("right"));
  byId("driveTankForm").addEventListener("submit", submitDriveTank);
  byId("fillTankButton").addEventListener("click", fillDriveTank);
}

async function init() {
  bindEvents();
  startDeviceGps();
  await pollStatus();
  await loadHistory();
  state.pollTimer = setInterval(pollStatus, 1000);
}

document.addEventListener("DOMContentLoaded", init);
