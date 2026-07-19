const companySlug = window.APP_COMPANY || 'fer-consulting';
const sessionUserKey = `invoice_user_${companySlug}`;

const state = {
  clients: [],
  services: [],
  clientPrices: [],
  users: [],
  invoices: [],
  selectedClient: null,
  settings: {},
  configFilters: {
    clients: '',
    services: '',
    users: '',
    invoices: '',
  },
  rows: 10,
  editingInvoiceId: null,
  editingInvoiceStatus: null,
  editingInvoiceNumber: null,
  editingInvoiceDate: null,
  pendingDeleteInvoiceId: null,
  restoringInvoiceDraft: false,
  currentUser: JSON.parse(sessionStorage.getItem(sessionUserKey) || 'null'),
  voice: {
    recognition: null,
    active: false,
    step: 0,
    draft: {},
  },
};

const fmtMoney = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const fmtDate = new Intl.DateTimeFormat('es-ES');
const qs = (s) => document.querySelector(s);
const urlParams = new URLSearchParams(window.location.search);
const invoiceDraftKey = `invoice_draft_${companySlug}`;
const viewKey = `active_view_${companySlug}`;

function toast(message) {
  const el = qs('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3600);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function showInvoiceDate(value = todayISO()) {
  qs('#invoiceDateText').textContent = fmtDate.format(new Date(`${value}T12:00:00`));
}

function escapeHtml(text) {
  return (text ?? '').toString().replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function normalize(text) {
  return (text || '').toString().trim().toLocaleLowerCase('es-ES');
}

function serviceByName(name) {
  const n = normalize(name);
  return state.services.find(s => normalize(s.name) === n) || null;
}

function clientByName(name) {
  const n = normalize(name);
  return state.clients.find(c => normalize(c.name) === n) || null;
}

function cleanString(value) {
  return value == null ? '' : String(value).trim();
}

function clientHasEmail(client = state.selectedClient) {
  return Boolean(cleanString(client?.email));
}

function clientForPayload() {
  const client = state.selectedClient || {};
  return {
    id: client.id ?? null,
    external_code: cleanString(client.external_code),
    name: cleanString(client.name || qs('#clientInput').value),
    tax_id: cleanString(client.tax_id),
    address: cleanString(client.address),
    postal_code: cleanString(client.postal_code),
    city: cleanString(client.city),
    email: cleanString(client.email),
    default_payment_method: cleanString(client.default_payment_method),
    default_delivery_method: cleanString(client.default_delivery_method),
  };
}

function updateDeliveryEmailAvailability() {
  const deliverySelect = qs('#deliveryMethodInput');
  const emailOption = deliverySelect?.querySelector('option[value="email"]');
  if (!deliverySelect || !emailOption) return;
  const canUseEmail = clientHasEmail();
  emailOption.disabled = !canUseEmail;
  emailOption.title = canUseEmail ? '' : 'Anade un email al cliente para poder enviar por email';
  if (!canUseEmail && deliverySelect.value === 'email') {
    deliverySelect.value = 'postal';
  }
}

function bestMatch(rows, text, fields) {
  const query = normalize(text);
  if (!query) return null;
  const exact = rows.find(row => fields.some(field => normalize(row[field]) === query));
  if (exact) return exact;
  const contains = rows
    .map(row => {
      const haystack = fields.map(field => normalize(row[field])).join(' ');
      const words = query.split(/\s+/).filter(Boolean);
      const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
      return { row, score, haystack };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.haystack.length - b.haystack.length);
  return contains[0]?.row || null;
}

function parseVoiceNumber(text) {
  const cleaned = normalize(text).replace(',', '.');
  const numeric = cleaned.match(/\d+(\.\d+)?/);
  if (numeric) return Number(numeric[0]);
  const words = {
    uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
    once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
  };
  return words[cleaned] || 0;
}

function formatDiscountInputValue(rate) {
  const pct = Number(rate || 0) * 100;
  return pct > 0 ? String(pct) : '';
}

function recommendedPriceFor(service) {
  if (!state.selectedClient || !service) return null;
  return state.clientPrices.find(row => {
    const sameClient = (
      state.selectedClient.id && Number(row.client_id) === Number(state.selectedClient.id)
    ) || (
      !state.selectedClient.id && normalize(row.client_name) === normalize(state.selectedClient.name)
    );
    const sameService = (
      service.id && Number(row.service_id) === Number(service.id)
    ) || (
      !service.id && normalize(row.service_name) === normalize(service.name)
    );
    return sameClient && sameService;
  }) || null;
}

function applyRecommendedPrice(row, service, force = false) {
  const priceInput = row.querySelector('.price-input');
  const current = Number(priceInput.value || 0);
  const basePrice = Number(service?.unit_price || 0);
  const customPrice = recommendedPriceFor(service);
  const nextPrice = customPrice ? Number(customPrice.unit_price || 0) : basePrice;
  if (force || !current || current === basePrice) {
    priceInput.value = nextPrice;
  }
  row.classList.toggle('has-client-price', Boolean(customPrice));
  priceInput.title = customPrice ? 'Precio recomendado por ultimo uso de este cliente' : 'Precio base del servicio';
}

function firstInvoiceRow() {
  return qs('#lineItems tr');
}

function fillVoiceDraftIntoInvoice() {
  const { client, service, quantity, price, payment, delivery, notes } = state.voice.draft;
  if (client) {
    qs('#clientInput').value = client.name;
    selectClientByInput();
  }
  if (service) {
    const row = firstInvoiceRow();
    row.querySelector('.qty-input').value = quantity || 1;
    row.querySelector('.service-input').value = service.name;
    row.querySelector('.unit-cell').textContent = service.unit || '';
    applyRecommendedPrice(row, service, true);
    if (price) row.querySelector('.price-input').value = price;
  }
  if (payment) qs('#paymentMethodInput').value = payment;
  if (delivery) qs('#deliveryMethodInput').value = delivery;
  if (notes) qs('#notesInput').value = notes;
  updatePrintTexts();
  calculateTotals();
  saveInvoiceDraft();
}

const voiceSteps = [
  { key: 'client', question: 'Dime el cliente para la factura.' },
  { key: 'service', question: 'Dime el servicio o articulo que quieres facturar.' },
  { key: 'quantity', question: 'Dime la cantidad.' },
  { key: 'price', question: 'Te propongo el precio recomendado. Di aceptar, o dime otro precio.' },
  { key: 'payment', question: 'Forma de pago: di transferencia o giro.' },
  { key: 'delivery', question: 'Forma de envio: di email o correo postal.' },
  { key: 'notes', question: 'Dime comentarios para la factura, o di sin comentarios.' },
  { key: 'confirm', question: 'He rellenado la factura. Di registrar para guardarla, o solo preparar para revisarla.' },
];

function setVoiceStatus(text) {
  qs('#voiceStatus').textContent = text;
}

function setVoiceTranscript(text) {
  qs('#voiceTranscript').textContent = text || 'Sin respuesta todavia.';
}

function speak(text) {
  setVoiceStatus(text);
  if (!('speechSynthesis' in window)) return Promise.resolve();
  window.speechSynthesis.cancel();
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = 0.96;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    window.speechSynthesis.speak(utterance);
  });
}

function ensureVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  if (!state.voice.recognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = event => {
      const text = event.results?.[0]?.[0]?.transcript || '';
      setVoiceTranscript(text);
      handleVoiceAnswer(text);
    };
    recognition.onerror = event => {
      setVoiceStatus(`No he podido escuchar bien (${event.error}). Pulsa repetir.`);
    };
    recognition.onend = () => {
      if (state.voice.active) qs('#voiceStartBtn').disabled = false;
    };
    state.voice.recognition = recognition;
  }
  return state.voice.recognition;
}

async function askVoiceStep() {
  if (!state.voice.active) return;
  const step = voiceSteps[state.voice.step];
  if (!step) return stopVoiceAssistant('Asistente finalizado.');
  await speak(step.question);
  const recognition = ensureVoiceRecognition();
  if (!recognition) {
    stopVoiceAssistant('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.');
    return;
  }
  qs('#voiceStartBtn').disabled = true;
  recognition.start();
}

function handleVoiceAnswer(rawText) {
  const text = normalize(rawText);
  if (!text) return askVoiceStep();
  if (text.includes('cancelar') || text.includes('detener')) {
    stopVoiceAssistant('Asistente detenido.');
    return;
  }
  const step = voiceSteps[state.voice.step];
  const draft = state.voice.draft;
  if (step.key === 'client') {
    const client = bestMatch(state.clients, text, ['name', 'tax_id', 'city']);
    if (!client) return speak('No encuentro ese cliente. Repite el nombre.').then(askVoiceStep);
    draft.client = client;
    qs('#clientInput').value = client.name;
    selectClientByInput();
  }
  if (step.key === 'service') {
    const service = bestMatch(state.services.filter(s => s.active !== false), text, ['name', 'code']);
    if (!service) return speak('No encuentro ese servicio. Repite el articulo.').then(askVoiceStep);
    draft.service = service;
    fillVoiceDraftIntoInvoice();
  }
  if (step.key === 'quantity') {
    const quantity = parseVoiceNumber(text);
    if (!quantity) return speak('No he entendido la cantidad. Dime un numero.').then(askVoiceStep);
    draft.quantity = quantity;
    fillVoiceDraftIntoInvoice();
  }
  if (step.key === 'price') {
    const row = firstInvoiceRow();
    if (text.includes('acept')) {
      draft.price = Number(row.querySelector('.price-input').value || draft.service?.unit_price || 0);
    } else {
      const price = parseVoiceNumber(text);
      if (!price) return speak('No he entendido el precio. Di aceptar o dime otro importe.').then(askVoiceStep);
      draft.price = price;
    }
    fillVoiceDraftIntoInvoice();
  }
  if (step.key === 'payment') {
    draft.payment = text.includes('giro') ? 'GIRO' : (state.settings.default_payment_method || 'GIRO');
    fillVoiceDraftIntoInvoice();
  }
  if (step.key === 'delivery') {
    draft.delivery = text.includes('postal') || text.includes('correo') ? 'postal' : 'email';
    fillVoiceDraftIntoInvoice();
  }
  if (step.key === 'notes') {
    draft.notes = text.includes('sin comentario') || text.includes('ningun') ? '' : rawText.trim();
    fillVoiceDraftIntoInvoice();
  }
  if (step.key === 'confirm') {
    stopVoiceAssistant('Factura preparada.');
    if (text.includes('registr')) registerInvoice();
    return;
  }
  state.voice.step += 1;
  askVoiceStep();
}

function startVoiceAssistant() {
  setView('invoice');
  const recognition = ensureVoiceRecognition();
  if (!recognition) {
    toast('El reconocimiento de voz necesita Chrome o Edge.');
    return;
  }
  qs('#voicePanel').classList.add('show');
  state.voice.active = true;
  state.voice.step = 0;
  state.voice.draft = {};
  setVoiceTranscript('');
  askVoiceStep();
}

function stopVoiceAssistant(message = 'Asistente detenido.') {
  state.voice.active = false;
  qs('#voiceStartBtn').disabled = false;
  try { state.voice.recognition?.stop(); } catch (_) {}
  window.speechSynthesis?.cancel();
  setVoiceStatus(message);
}

function rememberClientPrices(payload) {
  const now = new Date().toISOString();
  (payload.items || []).forEach(item => {
    if (!item.description || Number(item.unit_price || 0) <= 0) return;
    const service = item.service_id ? state.services.find(s => Number(s.id) === Number(item.service_id)) : serviceByName(item.description);
    const existingIndex = state.clientPrices.findIndex(row => {
      const sameClient = (
        payload.client.id && Number(row.client_id) === Number(payload.client.id)
      ) || (
        !payload.client.id && normalize(row.client_name) === normalize(payload.client.name)
      );
      const sameService = (
        item.service_id && Number(row.service_id) === Number(item.service_id)
      ) || (
        !item.service_id && normalize(row.service_name) === normalize(item.description)
      );
      return sameClient && sameService;
    });
    const next = {
      id: existingIndex >= 0 ? state.clientPrices[existingIndex].id : Date.now(),
      client_id: payload.client.id || null,
      client_name: payload.client.name || '',
      service_id: item.service_id || service?.id || null,
      service_name: item.description,
      unit: item.unit || service?.unit || '',
      unit_price: Number(item.unit_price || 0),
      updated_at: now,
    };
    if (existingIndex >= 0) state.clientPrices[existingIndex] = { ...state.clientPrices[existingIndex], ...next };
    else state.clientPrices.push(next);
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Company': companySlug, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail;
    const message = Array.isArray(detail)
      ? detail.map(err => `${(err.loc || []).join('.')}: ${err.msg}`).join(' | ')
      : (typeof detail === 'string' ? detail : JSON.stringify(detail || data));
    throw new Error(message || 'Operacion no completada');
  }
  return data;
}

function setView(name) {
  const view = name === 'config' ? 'config' : 'invoice';
  sessionStorage.setItem(viewKey, view);
  qs('#invoiceView').classList.toggle('active', view === 'invoice');
  qs('#configView').classList.toggle('active', view === 'config');
  qs('#printBtn').style.display = view === 'invoice' ? '' : 'none';
  qs('#registerBtn').style.display = view === 'invoice' ? '' : 'none';
  qs('#invoiceViewBtn').classList.toggle('active', view === 'invoice');
  qs('#configViewBtn').classList.toggle('active', view === 'config');
  if (view === 'config') loadConfig();
}

function invoiceDraftRows() {
  return Array.from(document.querySelectorAll('#lineItems tr')).map(row => ({
    quantity: row.querySelector('.qty-input').value,
    service: row.querySelector('.service-input').value,
    unit: row.querySelector('.unit-cell').textContent,
    price: row.querySelector('.price-input').value,
    discount: row.querySelector('.discount-input').value,
  }));
}

function saveInvoiceDraft() {
  if (state.restoringInvoiceDraft) return;
  const rows = invoiceDraftRows();
  const hasContent = Boolean(
    state.editingInvoiceId ||
    qs('#clientInput').value.trim() ||
    qs('#notesInput').value.trim() ||
    qs('#withholdingInput')?.checked ||
    rows.some(row => row.quantity || row.service || row.price || row.discount)
  );
  if (!hasContent) {
    clearSavedInvoiceDraft();
    return;
  }
  const draft = {
    saved_at: new Date().toISOString(),
    editing_invoice_id: state.editingInvoiceId,
    editing_invoice_status: state.editingInvoiceStatus,
    editing_invoice_number: state.editingInvoiceNumber,
    editing_invoice_date: state.editingInvoiceDate,
    register_button_text: qs('#registerBtn').textContent,
    rows_count: state.rows,
    client_input: qs('#clientInput').value,
    invoice_type: qs('#invoiceTypeInput').value,
    vat_rate: qs('#vatRateInput').value,
    withholding_applied: Boolean(qs('#withholdingInput')?.checked),
    payment_method: qs('#paymentMethodInput').value,
    delivery_method: qs('#deliveryMethodInput').value,
    sequence: qs('#sequenceInput').value,
    notes: qs('#notesInput').value,
    rows,
  };
  sessionStorage.setItem(invoiceDraftKey, JSON.stringify(draft));
}

function clearSavedInvoiceDraft() {
  sessionStorage.removeItem(invoiceDraftKey);
}

function restoreInvoiceDraft() {
  const raw = sessionStorage.getItem(invoiceDraftKey);
  if (!raw) return;
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (_) {
    clearSavedInvoiceDraft();
    return;
  }
  state.restoringInvoiceDraft = true;
  try {
    state.editingInvoiceId = draft.editing_invoice_id || null;
    state.editingInvoiceStatus = draft.editing_invoice_status || null;
    state.editingInvoiceNumber = draft.editing_invoice_number || null;
    state.editingInvoiceDate = draft.editing_invoice_date || null;
    qs('#registerBtn').textContent = draft.register_button_text || (state.editingInvoiceId ? 'Guardar cambios' : '2 Registrar factura');
    renderRows(Math.max(10, Number(draft.rows_count || 0), (draft.rows || []).length));
    qs('#clientInput').value = draft.client_input || '';
    qs('#invoiceTypeInput').value = draft.invoice_type || 'invoice';
    qs('#vatRateInput').value = draft.vat_rate || '0.21';
    if (qs('#withholdingInput')) qs('#withholdingInput').checked = Boolean(draft.withholding_applied);
    qs('#notesInput').value = draft.notes || '';
    if (draft.sequence) qs('#sequenceInput').value = draft.sequence;
    (draft.rows || []).forEach((item, index) => {
      const row = qs('#lineItems').children[index];
      if (!row) return;
      row.querySelector('.qty-input').value = item.quantity || '';
      row.querySelector('.service-input').value = item.service || '';
      row.querySelector('.unit-cell').textContent = item.unit || '';
      row.querySelector('.price-input').value = item.price || '';
      row.querySelector('.discount-input').value = item.discount || '';
    });
    selectClientByInput();
    qs('#paymentMethodInput').value = draft.payment_method || state.settings.default_payment_method || qs('#paymentMethodInput').value;
    qs('#deliveryMethodInput').value = draft.delivery_method || qs('#deliveryMethodInput').value;
    updateInvoiceNumberDisplay();
    updatePrintTexts();
    calculateTotals();
  } finally {
    state.restoringInvoiceDraft = false;
  }
}

function fillDataLists() {
  closeAutocomplete();
}

function upsertStateRow(collection, row) {
  if (!row || row.id == null) return;
  const index = state[collection].findIndex(item => String(item.id) === String(row.id));
  if (index >= 0) state[collection][index] = { ...state[collection][index], ...row };
  else state[collection].push(row);
}

function deleteStateRow(collection, id) {
  state[collection] = state[collection].filter(item => String(item.id) !== String(id));
}

function autocompleteMenu() {
  let menu = qs('#autocompleteMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'autocompleteMenu';
    menu.className = 'combo-menu hidden';
    document.body.appendChild(menu);
  }
  return menu;
}

function closeAutocomplete() {
  const menu = qs('#autocompleteMenu');
  if (menu) menu.classList.add('hidden');
}

function comboMatches(kind, query) {
  const normalizedQuery = normalize(query);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const rows = kind === 'client'
    ? state.clients.map(client => ({
      value: client.name,
      label: client.name,
      detail: [client.tax_id, client.postal_code, client.city].filter(Boolean).join(' - '),
      haystack: [client.name, client.tax_id, client.postal_code, client.city].filter(Boolean).join(' '),
    }))
    : state.services.filter(service => service.active !== false).map(service => ({
      value: service.name,
      label: service.name,
      detail: [service.unit, fmtMoney.format(Number(service.unit_price || 0))].filter(Boolean).join(' - '),
      haystack: [service.name, service.code, service.unit, service.unit_price].filter(Boolean).join(' '),
    }));
  return rows
    .map(row => {
      const haystack = normalize(row.haystack);
      const phraseMatch = normalizedQuery && haystack.includes(normalizedQuery);
      const allTermsMatch = terms.length > 0 && terms.every(term => haystack.includes(term));
      const startsMatch = normalizedQuery && haystack.startsWith(normalizedQuery);
      const score = startsMatch ? 3 : (phraseMatch ? 2 : (allTermsMatch ? 1 : 0));
      return { ...row, score, haystack };
    })
    .filter(row => terms.length === 0 || row.score > 0)
    .sort((a, b) => b.score - a.score || a.haystack.length - b.haystack.length)
    .slice(0, 30);
}

function openAutocomplete(input, kind) {
  const menu = autocompleteMenu();
  const matches = comboMatches(kind, input.value);
  if (!matches.length) {
    const rect = input.getBoundingClientRect();
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.width = `${rect.width}px`;
    menu.innerHTML = '<div class="combo-empty">Sin coincidencias</div>';
    menu.classList.remove('hidden');
    return;
  }
  const rect = input.getBoundingClientRect();
  menu.style.left = `${rect.left + window.scrollX}px`;
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.width = `${rect.width}px`;
  menu.innerHTML = matches.map(item => `<button class="combo-option" type="button" data-value="${escapeHtml(item.value)}"><strong>${escapeHtml(item.label)}</strong>${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}</button>`).join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('.combo-option').forEach(option => {
    option.addEventListener('mousedown', event => {
      event.preventDefault();
      input.value = option.dataset.value || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closeAutocomplete();
    });
  });
}

function createRow(index) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="qty-input" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Cantidad linea ${index}"></td>
    <td><input class="service-input combo-input" autocomplete="off" aria-label="Servicio linea ${index}"></td>
    <td><span class="readonly-cell unit-cell"></span></td>
    <td><input class="price-input" type="number" min="0" step="0.0001" inputmode="decimal" aria-label="Precio linea ${index}"></td>
    <td><input class="discount-input" type="number" min="0" max="100" step="0.01" inputmode="decimal" aria-label="Descuento linea ${index}"></td>
    <td><span class="readonly-cell amount-cell">-</span></td>`;
  return tr;
}

function renderRows(count = state.rows) {
  state.rows = count;
  const tbody = qs('#lineItems');
  tbody.innerHTML = '';
  for (let i = 1; i <= state.rows; i++) tbody.appendChild(createRow(i));
  if (!tbody.dataset.bound) {
    tbody.addEventListener('input', onTableInput);
    tbody.addEventListener('change', onTableInput);
    tbody.addEventListener('focusin', event => {
      if (event.target.classList?.contains('service-input')) openAutocomplete(event.target, 'service');
    });
    tbody.dataset.bound = 'true';
  }
}

function addLine() {
  state.rows += 1;
  qs('#lineItems').appendChild(createRow(state.rows));
  calculateTotals();
  saveInvoiceDraft();
}

function onTableInput(event) {
  const row = event.target.closest('tr');
  if (!row) return;
  if (event.target.classList.contains('discount-input') && Number(event.target.value || 0) === 0) {
    event.target.value = '';
  }
  const serviceInput = row.querySelector('.service-input');
  const service = serviceByName(serviceInput.value);
  if (event.target.classList.contains('service-input')) {
    openAutocomplete(serviceInput, 'service');
  }
  if (service && event.target.classList.contains('service-input')) {
    row.querySelector('.unit-cell').textContent = service.unit || '';
    applyRecommendedPrice(row, service, true);
  }
  calculateTotals();
}

function calculateTotals() {
  let subtotal = 0;
  let lines = 0;
  document.querySelectorAll('#lineItems tr').forEach(row => {
    const qty = Number(row.querySelector('.qty-input').value || 0);
    const price = Number(row.querySelector('.price-input').value || 0);
    const discountPct = Number(row.querySelector('.discount-input').value || 0);
    const serviceName = row.querySelector('.service-input').value.trim();
    const amount = qty > 0 && serviceName ? qty * price * (1 - Math.min(Math.max(discountPct, 0), 100) / 100) : 0;
    row.querySelector('.amount-cell').textContent = amount ? fmtMoney.format(amount) : '-';
    subtotal += amount;
    if (qty > 0 && serviceName) lines += 1;
  });
  const vatRate = Number(qs('#vatRateInput').value || state.settings.vat_rate || 0.21);
  const vat = subtotal * vatRate;
  const withholdingRate = qs('#withholdingInput')?.checked ? 0.19 : 0;
  const withholding = subtotal * withholdingRate;
  const total = subtotal + vat - withholding;
  qs('#subtotalText').textContent = fmtMoney.format(subtotal);
  qs('#vatLabel').textContent = `I.V.A. ${vatRate ? `${Math.round(vatRate * 100)}%` : '0%'}`;
  qs('#vatText').textContent = fmtMoney.format(vat);
  if (qs('#withholdingRow')) qs('#withholdingRow').hidden = withholdingRate === 0;
  if (qs('#withholdingText')) qs('#withholdingText').textContent = `-${fmtMoney.format(withholding)}`;
  qs('#totalText').textContent = fmtMoney.format(total);
  qs('#summaryLines').textContent = lines;
  qs('#summaryTotal').textContent = fmtMoney.format(total);
  return { subtotal, vat, withholding, total, lines };
}

function updatePrintTexts() {
  updateDeliveryEmailAvailability();
  syncNotesPrintState();
  const payment = qs('#paymentMethodInput').value;
  const delivery = qs('#deliveryMethodInput').value === 'postal' ? 'Correo postal' : 'Email';
  qs('#paymentMethodText').textContent = payment;
  qs('#deliveryMethodText').textContent = delivery;
  qs('.invoice-meta .title').textContent = qs('#invoiceTypeInput').value === 'proforma' ? 'Proforma' : 'Factura';
}

function syncNotesPrintState() {
  qs('.notes-block')?.classList.toggle('print-empty-notes', !qs('#notesInput')?.value.trim());
}

function selectClientByInput() {
  const client = clientByName(qs('#clientInput').value);
  state.selectedClient = client;
  const address = client?.address || '';
  const cityLine = [client?.postal_code, client?.city].filter(Boolean).join(' ');
  qs('#clientTaxId').textContent = client?.tax_id || '';
  qs('#clientAddress').textContent = address;
  qs('#clientCity').textContent = cityLine;
  qs('#summaryClient').textContent = client?.name || '-';
  qs('#windowClient').textContent = client?.name || qs('#clientInput').value || 'Cliente';
  qs('#windowAddress').textContent = address || 'Direccion';
  qs('#windowCity').textContent = cityLine || 'C.P. Ciudad';
  if (client?.default_payment_method) qs('#paymentMethodInput').value = client.default_payment_method;
  if (client?.default_delivery_method) qs('#deliveryMethodInput').value = client.default_delivery_method;
  updateDeliveryEmailAvailability();
  updatePrintTexts();
  document.querySelectorAll('#lineItems tr').forEach(row => {
    const service = serviceByName(row.querySelector('.service-input').value);
    if (service) applyRecommendedPrice(row, service, false);
  });
  calculateTotals();
}

function collectPayload(status = 'pendiente_envio') {
  const rows = [];
  document.querySelectorAll('#lineItems tr').forEach(row => {
    const serviceName = row.querySelector('.service-input').value.trim();
    const service = serviceByName(serviceName);
    const quantity = Number(row.querySelector('.qty-input').value || 0);
    const unit_price = Number(row.querySelector('.price-input').value || 0);
    const discountPct = Number(row.querySelector('.discount-input').value || 0);
    if (serviceName || quantity || unit_price) {
      rows.push({
        service_id: service?.id || null,
        description: serviceName,
        quantity,
        unit: row.querySelector('.unit-cell').textContent.trim(),
        unit_price,
        discount_rate: Math.min(Math.max(discountPct, 0), 100) / 100,
      });
    }
  });
  const payload = {
    invoice_type: qs('#invoiceTypeInput').value,
    invoice_date: state.editingInvoiceDate || todayISO(),
    fiscal_year: Number(state.settings.fiscal_year || new Date().getFullYear()),
    client: clientForPayload(),
    items: rows,
    vat_rate: Number(qs('#vatRateInput').value || 0.21),
    withholding_rate: qs('#withholdingInput')?.checked ? 0.19 : 0,
    payment_method: qs('#paymentMethodInput').value,
    delivery_method: qs('#deliveryMethodInput').value,
    notes: qs('#notesInput').value.trim(),
  };
  if (state.editingInvoiceId) {
    payload.status = state.editingInvoiceStatus || (qs('#invoiceTypeInput').value === 'proforma' ? 'proforma' : status);
    payload.sent_by = '';
    payload.sent_at = null;
  }
  return payload;
}

async function registerInvoice() {
  selectClientByInput();
  updatePrintTexts();
  const payload = collectPayload();
  if (!payload.client?.name) return toast('Selecciona un cliente antes de registrar.');
  if (payload.delivery_method === 'email' && !payload.client.email) return toast('Este cliente no tiene email. Anadelo en Configuracion > Clientes o usa correo postal.');
  if (!payload.items.length) return toast('Anade al menos una linea de factura.');
  const btn = qs('#registerBtn');
  btn.disabled = true;
  try {
    const method = state.editingInvoiceId ? 'PUT' : 'POST';
    const path = state.editingInvoiceId ? `/api/invoices/${state.editingInvoiceId}` : '/api/invoices';
    const data = await api(path, { method, body: JSON.stringify(payload) });
    const invoice = data.invoice;
    rememberClientPrices(payload);
    toast(`${invoice.invoice_type === 'proforma' ? 'Proforma' : 'Factura'} ${invoice.invoice_number} ${state.editingInvoiceId ? 'actualizada' : 'registrada'}.`);
    if (data.next) {
      state.settings.sequence = data.next.sequence;
      state.settings.invoice_number = data.next.invoice_number;
      state.settings.prefix = data.next.prefix || state.settings.prefix;
      state.settings.fiscal_year = data.next.fiscal_year || state.settings.fiscal_year;
    }
    if (data.proforma_next) {
      state.settings.proforma_sequence = data.proforma_next.proforma_sequence;
      state.settings.proforma_number = data.proforma_next.proforma_number;
      state.settings.proforma_prefix = data.proforma_next.proforma_prefix || state.settings.proforma_prefix;
    }
    updateInvoiceNumberDisplay();
    fillCounterForm();
    clearForm(false);
    await loadLastInvoices();
  } catch (err) {
    toast(err.message || 'Error registrando factura');
  } finally {
    btn.disabled = false;
  }
}

function clearForm(showToast = true) {
  state.editingInvoiceId = null;
  state.editingInvoiceStatus = null;
  state.editingInvoiceNumber = null;
  state.editingInvoiceDate = null;
  showInvoiceDate();
  qs('#registerBtn').textContent = '2 Registrar factura';
  qs('#clientInput').value = '';
  qs('#notesInput').value = '';
  qs('#invoiceTypeInput').value = 'invoice';
  qs('#vatRateInput').value = '0.21';
  if (qs('#withholdingInput')) qs('#withholdingInput').checked = false;
  qs('#deliveryMethodInput').value = 'email';
  qs('#paymentMethodInput').value = state.settings.default_payment_method || 'GIRO';
  updateInvoiceNumberDisplay();
  selectClientByInput();
  document.querySelectorAll('#lineItems tr').forEach(row => {
    row.querySelector('.qty-input').value = '';
    row.querySelector('.service-input').value = '';
    row.querySelector('.price-input').value = '';
    row.querySelector('.discount-input').value = '';
    row.querySelector('.unit-cell').textContent = '';
    row.querySelector('.amount-cell').textContent = '-';
  });
  updatePrintTexts();
  calculateTotals();
  clearSavedInvoiceDraft();
  if (showToast) toast('Formulario limpio.');
}

async function loadInvoiceIntoForm(invoiceId) {
  const invoice = await api(`/api/invoices/${invoiceId}`);
  state.editingInvoiceId = invoice.id;
  state.editingInvoiceStatus = invoice.status || null;
  state.editingInvoiceNumber = invoiceDisplayParts(invoice);
  state.editingInvoiceDate = invoice.invoice_date || null;
  showInvoiceDate(state.editingInvoiceDate || todayISO());
  const existing = state.clients.find(c => Number(c.id) === Number(invoice.client_id));
  state.selectedClient = existing || {
    id: invoice.client_id,
    name: invoice.client_name,
    tax_id: invoice.client_tax_id,
    address: invoice.client_address,
    postal_code: invoice.client_postal_code,
    city: invoice.client_city,
    email: invoice.client_email,
  };
  qs('#clientInput').value = invoice.client_name || '';
  qs('#paymentMethodInput').value = invoice.payment_method || state.settings.default_payment_method || qs('#paymentMethodInput').value;
  qs('#deliveryMethodInput').value = invoice.delivery_method || 'email';
  qs('#invoiceTypeInput').value = invoice.invoice_type || 'invoice';
  updateInvoiceNumberDisplay();
  qs('#vatRateInput').value = String(Number(invoice.vat_rate ?? 0.21));
  if (qs('#withholdingInput')) qs('#withholdingInput').checked = Number(invoice.withholding_rate || 0) === 0.19;
  qs('#notesInput').value = invoice.notes || '';
  renderRows(Math.max(10, (invoice.items || []).length));
  (invoice.items || []).forEach((item, index) => {
    const row = qs('#lineItems').children[index];
    row.querySelector('.qty-input').value = item.quantity || '';
    row.querySelector('.service-input').value = item.description || '';
    row.querySelector('.unit-cell').textContent = item.unit || '';
    row.querySelector('.price-input').value = item.unit_price || '';
    row.querySelector('.discount-input').value = formatDiscountInputValue(item.discount_rate);
  });
  selectClientByInput();
  updatePrintTexts();
  calculateTotals();
  qs('#registerBtn').textContent = 'Guardar cambios';
  saveInvoiceDraft();
  setView('invoice');
  toast(`Editando factura ${invoice.invoice_number}.`);
}

async function loadLastInvoices() {
  try {
    const invoices = await api('/api/invoices');
    state.invoices = invoices;
    const box = qs('#lastInvoices');
    if (!Array.isArray(invoices) || !invoices.length) {
      box.textContent = 'Sin registros todavia.';
      return;
    }
    box.innerHTML = invoices.slice(0, 5).map(inv => `<button class="last-item" type="button" data-edit-invoice="${escapeHtml(inv.id)}"><strong>${escapeHtml(inv.invoice_number)}</strong><span>${escapeHtml(inv.client_name || '')}</span><br><span>${fmtMoney.format(Number(inv.total || 0))}</span></button>`).join('');
  } catch (_) {}
}

async function loadConfig() {
  try {
    const data = await api('/api/config');
    state.clients = data.clients || [];
    state.services = data.services || [];
    state.clientPrices = data.client_prices || [];
    state.users = data.users || [];
    state.invoices = data.invoices || [];
    state.settings = data.settings || state.settings;
    fillDataLists();
    fillCounterForm();
    renderClientsTable();
    renderServicesTable();
    renderUsersTable();
    renderInvoicesTable();
  } catch (err) {
    toast(err.message || 'No se pudo cargar la configuracion.');
  }
}

function actionButtons(kind, id) {
  return `<button class="mini-btn" data-edit-${kind}="${id}" type="button">Editar</button><button class="mini-btn danger" data-delete-${kind}="${id}" type="button">Borrar</button>`;
}

function clientActionButtons(id) {
  return `<div class="client-row-actions"><button class="mini-btn label-btn" data-print-client-label="${id}" type="button">Etiqueta A4</button><button class="mini-btn" data-edit-client="${id}" type="button">Editar</button><button class="mini-btn danger" data-delete-client="${id}" type="button">Borrar</button></div>`;
}

function paymentPreferenceOptions(value = '') {
  const transfer = state.settings.default_payment_method || '';
  const options = [
    ['', 'Sin preferencia'],
    [transfer, 'Transferencia'],
    ['GIRO', 'Giro'],
  ].filter(([optionValue], index) => optionValue || index === 0);
  return options.map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}" ${optionValue === value ? 'selected' : ''}>${label}</option>`).join('');
}

function deliveryPreferenceOptions(value = '') {
  const options = [
    ['', 'Sin preferencia'],
    ['email', 'Email'],
    ['postal', 'Correo postal'],
  ];
  return options.map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}" ${optionValue === value ? 'selected' : ''}>${label}</option>`).join('');
}

function tableSearchTerms(kind) {
  return normalize(state.configFilters[kind]).split(/\s+/).filter(Boolean);
}

function rowMatchesTerms(row, terms, fields) {
  if (!terms.length) return true;
  const haystack = normalize(fields.map(field => {
    const value = typeof field === 'function' ? field(row) : row[field];
    return value == null ? '' : String(value);
  }).join(' '));
  return terms.every(term => haystack.includes(term));
}

function emptyTableRow(colspan, message) {
  return `<tr><td class="empty-table-row" colspan="${colspan}">${escapeHtml(message)}</td></tr>`;
}

function renderClientsTable() {
  const rows = state.clients.filter(c => rowMatchesTerms(c, tableSearchTerms('clients'), ['name', 'tax_id', 'postal_code', 'city', 'province', 'phone', 'email', 'default_payment_method', 'default_delivery_method']));
  qs('#clientsTable').innerHTML = rows.length
    ? rows.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.tax_id)}</td><td>${escapeHtml(c.postal_code)}</td><td>${escapeHtml(c.city)}</td><td><input class="inline-client-input" data-client-field="email" data-client-id="${escapeHtml(c.id)}" type="email" value="${escapeHtml(c.email)}" autocomplete="email" aria-label="Email de ${escapeHtml(c.name)}"></td><td><select class="inline-client-select" data-client-field="default_payment_method" data-client-id="${escapeHtml(c.id)}" aria-label="Pago por defecto de ${escapeHtml(c.name)}">${paymentPreferenceOptions(c.default_payment_method || '')}</select></td><td><select class="inline-client-select" data-client-field="default_delivery_method" data-client-id="${escapeHtml(c.id)}" aria-label="Envio por defecto de ${escapeHtml(c.name)}">${deliveryPreferenceOptions(c.default_delivery_method || '')}</select></td><td class="client-actions-cell">${clientActionButtons(c.id)}</td></tr>`).join('')
    : emptyTableRow(8, 'Sin clientes que coincidan con la busqueda.');
}

function renderServicesTable() {
  const rows = state.services.filter(s => rowMatchesTerms(s, tableSearchTerms('services'), ['code', 'name', 'unit', 'unit_price', row => row.active === false ? 'No' : 'Si']));
  qs('#servicesTable').innerHTML = rows.length
    ? rows.map(s => `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.unit)}</td><td>${fmtMoney.format(Number(s.unit_price || 0))}</td><td>${s.active === false ? 'No' : 'Si'}</td><td>${actionButtons('service', s.id)}</td></tr>`).join('')
    : emptyTableRow(5, 'Sin servicios que coincidan con la busqueda.');
}

function renderUsersTable() {
  const rows = state.users.filter(u => rowMatchesTerms(u, tableSearchTerms('users'), ['username', 'email', 'role', row => row.active === false ? 'No' : 'Si']));
  qs('#usersTable').innerHTML = rows.length
    ? rows.map(u => `<tr><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role)}</td><td>${u.active === false ? 'No' : 'Si'}</td><td>${actionButtons('user', u.id)}</td></tr>`).join('')
    : emptyTableRow(5, 'Sin usuarios que coincidan con la busqueda.');
}

function renderInvoicesTable() {
  const statusOptions = ['proforma', 'pendiente_envio', 'enviada', 'pagada'];
  const rows = state.invoices.filter(inv => rowMatchesTerms(inv, tableSearchTerms('invoices'), ['invoice_number', row => row.invoice_type === 'proforma' ? 'Proforma' : 'Factura', 'client_name', 'payment_method', 'delivery_method', 'status', 'total']));
  qs('#invoicesTable').innerHTML = rows.length ? rows.map(inv => {
    const status = inv.status || (inv.invoice_type === 'proforma' ? 'proforma' : 'pendiente_envio');
    const options = statusOptions.map(opt => `<option value="${opt}" ${opt === status ? 'selected' : ''}>${opt}</option>`).join('');
    return `<tr><td>${escapeHtml(inv.invoice_number)}</td><td>${escapeHtml(inv.invoice_type === 'proforma' ? 'Proforma' : 'Factura')}</td><td>${escapeHtml(inv.client_name)}</td><td>${escapeHtml(inv.payment_method)}</td><td>${escapeHtml(inv.delivery_method || '')}</td><td><select class="status-select" data-status-invoice="${escapeHtml(inv.id)}">${options}</select></td><td>${fmtMoney.format(Number(inv.total || 0))}</td><td><button class="mini-btn" data-edit-invoice="${escapeHtml(inv.id)}" type="button">Editar</button><button class="mini-btn danger" data-delete-invoice="${escapeHtml(inv.id)}" type="button">Borrar</button></td></tr>`;
  }).join('') : emptyTableRow(8, 'Sin facturas que coincidan con la busqueda.');
}

function bindConfigSearches() {
  document.querySelectorAll('[data-config-search]').forEach(input => {
    input.addEventListener('input', event => {
      const kind = event.target.dataset.configSearch;
      state.configFilters[kind] = event.target.value || '';
      if (kind === 'clients') renderClientsTable();
      if (kind === 'services') renderServicesTable();
      if (kind === 'users') renderUsersTable();
      if (kind === 'invoices') renderInvoicesTable();
    });
  });
}

function openDeleteInvoiceModal(invoiceId) {
  const invoice = state.invoices.find(row => String(row.id) === String(invoiceId));
  state.pendingDeleteInvoiceId = invoiceId;
  qs('#deleteInvoiceText').textContent = invoice
    ? `Confirma tus credenciales para eliminar ${invoice.invoice_number} de ${invoice.client_name || 'cliente sin nombre'}.`
    : 'Confirma tus credenciales para eliminar el registro.';
  qs('#deleteInvoiceUser').value = state.currentUser?.username || '';
  qs('#deleteInvoicePassword').value = '';
  qs('#deleteInvoiceError').textContent = '';
  qs('#deleteInvoiceOverlay').classList.remove('hidden');
  qs('#deleteInvoicePassword').focus();
}

function closeDeleteInvoiceModal() {
  state.pendingDeleteInvoiceId = null;
  qs('#deleteInvoiceOverlay').classList.add('hidden');
  qs('#deleteInvoiceForm').reset();
  qs('#deleteInvoiceError').textContent = '';
}

async function confirmDeleteInvoice(event) {
  event.preventDefault();
  const invoiceId = state.pendingDeleteInvoiceId;
  if (!invoiceId) return closeDeleteInvoiceModal();
  const username = qs('#deleteInvoiceUser').value.trim();
  const password = qs('#deleteInvoicePassword').value;
  if (!username || !password) {
    qs('#deleteInvoiceError').textContent = 'Introduce usuario y contrasena.';
    return;
  }
  const btn = qs('#deleteInvoiceConfirmBtn');
  btn.disabled = true;
  qs('#deleteInvoiceError').textContent = '';
  try {
    await api(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ username, password }),
    });
    if (String(state.editingInvoiceId) === String(invoiceId)) clearForm(false);
    closeDeleteInvoiceModal();
    toast('Factura eliminada.');
    await loadLastInvoices();
    await loadConfig();
  } catch (err) {
    qs('#deleteInvoiceError').textContent = err.message || 'No se ha podido eliminar la factura.';
  } finally {
    btn.disabled = false;
  }
}

function clearClientForm() {
  ['#clientIdEdit', '#clientCodeEdit', '#clientNameEdit', '#clientTaxEdit', '#clientAddressEdit', '#clientPostalEdit', '#clientCityEdit', '#clientProvinceEdit', '#clientPhoneEdit', '#clientEmailEdit', '#clientPaymentEdit', '#clientDeliveryEdit'].forEach(id => qs(id).value = '');
}

function clearServiceForm() {
  ['#serviceIdEdit', '#serviceCodeEdit', '#serviceNameEdit', '#serviceUnitEdit', '#servicePriceEdit'].forEach(id => qs(id).value = '');
  qs('#serviceActiveEdit').value = 'true';
}

function clearUserForm() {
  ['#userIdEdit', '#usernameEdit', '#userPasswordEdit', '#userEmailEdit'].forEach(id => qs(id).value = '');
  qs('#userRoleEdit').value = 'admin';
  qs('#userActiveEdit').value = 'true';
}

function invoicePrefixFromSettings() {
  return state.settings.prefix || state.settings.invoice_prefix || 'FAC-';
}

function invoiceYearFromSettings() {
  return Number(state.settings.fiscal_year || new Date().getFullYear());
}

function invoiceSequenceFromSettings() {
  return Number(state.settings.sequence || state.settings.next_invoice_sequence || 1);
}

function invoiceDisplayParts(invoice) {
  const invoiceNumber = String(invoice?.invoice_number || '').trim();
  const match = invoiceNumber.match(/^(.+\.)(\d+)$/);
  if (match) {
    return { prefixText: match[1], sequence: match[2] };
  }
  const prefix = invoice?.invoice_type === 'proforma'
    ? (state.settings.proforma_prefix || 'PRO-')
    : invoicePrefixFromSettings();
  const year = Number(invoice?.fiscal_year || invoiceYearFromSettings());
  const sequence = Number(invoice?.sequence || 1);
  return { prefixText: invoiceNumber || `${prefix}${year}.`, sequence };
}

function currentInvoicePdfName() {
  const prefix = (qs('#invoicePrefixText')?.textContent || '').trim();
  const sequence = (qs('#sequenceInput')?.value || qs('#sequencePrint')?.textContent || '').trim();
  const number = `${prefix} ${sequence}`.trim();
  return (number || 'Factura').replace(/[\\/:*?"<>|]/g, '-');
}

function printInvoicePdf() {
  selectClientByInput();
  updatePrintTexts();
  calculateTotals();
  const originalTitle = document.title;
  document.title = currentInvoicePdfName();
  const restoreTitle = () => {
    document.title = originalTitle;
    window.removeEventListener('afterprint', restoreTitle);
  };
  window.addEventListener('afterprint', restoreTitle);
  window.print();
  setTimeout(restoreTitle, 2000);
}

function printClientLabel(client) {
  if (!client) return;
  qs('#labelClientName').textContent = cleanString(client.name) || 'Cliente';
  qs('#labelClientAddress').textContent = cleanString(client.address) || '-';
  qs('#labelClientCity').textContent = [cleanString(client.postal_code), cleanString(client.city)].filter(Boolean).join(' ') || '-';
  qs('#labelClientProvince').textContent = cleanString(client.province) || '-';
  qs('#labelClientPhone').textContent = cleanString(client.phone) || '-';
  qs('#clientLabelPrintable').setAttribute('aria-hidden', 'false');
  const originalTitle = document.title;
  document.title = `Etiqueta - ${cleanString(client.name) || 'Cliente'}`.replace(/[\\/:*?"<>|]/g, '-');
  document.body.classList.add('print-client-label');
  const restoreLabelPrint = () => {
    document.body.classList.remove('print-client-label');
    qs('#clientLabelPrintable').setAttribute('aria-hidden', 'true');
    document.title = originalTitle;
    window.removeEventListener('afterprint', restoreLabelPrint);
  };
  window.addEventListener('afterprint', restoreLabelPrint);
  window.print();
  setTimeout(restoreLabelPrint, 2000);
}

function updateInvoiceNumberDisplay() {
  if (state.editingInvoiceId && state.editingInvoiceNumber) {
    qs('#sequenceInput').value = state.editingInvoiceNumber.sequence;
    qs('#sequencePrint').textContent = qs('#sequenceInput').value;
    qs('#invoicePrefixText').textContent = state.editingInvoiceNumber.prefixText;
    updatePrintTexts();
    return;
  }
  const isProforma = qs('#invoiceTypeInput')?.value === 'proforma';
  const sequence = isProforma ? Number(state.settings.proforma_sequence || 1) : invoiceSequenceFromSettings();
  const prefix = isProforma ? (state.settings.proforma_prefix || 'PRO-') : invoicePrefixFromSettings();
  qs('#sequenceInput').value = sequence;
  qs('#sequencePrint').textContent = qs('#sequenceInput').value;
  qs('#invoicePrefixText').textContent = `${prefix}${invoiceYearFromSettings()}.`;
  updatePrintTexts();
}

function updateCounterPreview() {
  const year = Number(qs('#counterYearEdit')?.value || invoiceYearFromSettings());
  const prefix = qs('#counterPrefixEdit')?.value || invoicePrefixFromSettings();
  const sequence = Number(qs('#counterSequenceEdit')?.value || invoiceSequenceFromSettings());
  const preview = qs('#counterPreview');
  if (preview) preview.value = `${prefix}${year}.${sequence}`;
}

function fillCounterForm() {
  if (!qs('#counterYearEdit')) return;
  qs('#counterYearEdit').value = invoiceYearFromSettings();
  qs('#counterPrefixEdit').value = invoicePrefixFromSettings();
  qs('#counterSequenceEdit').value = invoiceSequenceFromSettings();
  updateCounterPreview();
}

async function saveInvoiceCounter(event) {
  event.preventDefault();
  try {
    const payload = {
      fiscal_year: Number(qs('#counterYearEdit').value),
      prefix: qs('#counterPrefixEdit').value.trim() || 'FAC-',
      next_sequence: Number(qs('#counterSequenceEdit').value),
    };
    const data = await api('/api/config/invoice-counter', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = data.settings || state.settings;
    fillCounterForm();
    updateInvoiceNumberDisplay();
    toast(`Siguiente factura: ${state.settings.invoice_number}.`);
  } catch (err) {
    toast(err.message || 'No se ha podido guardar el contador.');
  }
}

async function saveClient(event) {
  event.preventDefault();
  try {
    const id = qs('#clientIdEdit').value;
    const email = qs('#clientEmailEdit').value.trim();
    const defaultDeliveryMethod = qs('#clientDeliveryEdit').value;
    if (defaultDeliveryMethod === 'email' && !email) {
      return toast('Anade un email al cliente antes de guardar Email como envio por defecto.');
    }
    const payload = {
      external_code: qs('#clientCodeEdit').value.trim(),
      name: qs('#clientNameEdit').value.trim(),
      tax_id: qs('#clientTaxEdit').value.trim(),
      address: qs('#clientAddressEdit').value.trim(),
      postal_code: qs('#clientPostalEdit').value.trim(),
      city: qs('#clientCityEdit').value.trim(),
      province: qs('#clientProvinceEdit').value.trim(),
      phone: qs('#clientPhoneEdit').value.trim(),
      email,
      default_payment_method: qs('#clientPaymentEdit').value,
      default_delivery_method: defaultDeliveryMethod,
    };
    const saved = await api(id ? `/api/config/clients/${id}` : '/api/config/clients', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    upsertStateRow('clients', saved);
    toast('Cliente guardado.');
    clearClientForm();
    renderClientsTable();
    fillDataLists();
  } catch (err) {
    toast(err.message || 'No se ha podido guardar el cliente.');
  }
}

async function saveClientInline(target) {
  const id = target.dataset.clientId;
  const field = target.dataset.clientField;
  const client = state.clients.find(row => String(row.id) === String(id));
  if (!client || !field) return;
  const previousValue = client[field] || '';
  const nextValue = target.value.trim();
  const nextClient = { ...client, [field]: nextValue };
  if (field === 'default_delivery_method' && nextValue === 'email' && !cleanString(nextClient.email)) {
    target.value = previousValue;
    toast('Anade un email antes de guardar Email como envio por defecto.');
    return;
  }
  const payload = {
    external_code: cleanString(nextClient.external_code),
    name: cleanString(nextClient.name),
    tax_id: cleanString(nextClient.tax_id),
    address: cleanString(nextClient.address),
    postal_code: cleanString(nextClient.postal_code),
    city: cleanString(nextClient.city),
    province: cleanString(nextClient.province),
    phone: cleanString(nextClient.phone),
    email: cleanString(nextClient.email),
    default_payment_method: cleanString(nextClient.default_payment_method),
    default_delivery_method: cleanString(nextClient.default_delivery_method),
  };
  target.disabled = true;
  try {
    const saved = await api(`/api/config/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    Object.assign(client, saved);
    if (String(state.selectedClient?.id) === String(id)) {
      state.selectedClient = { ...state.selectedClient, ...saved };
      selectClientByInput();
    }
    toast('Cliente actualizado.');
  } catch (err) {
    target.value = previousValue;
    toast(err.message || 'No se ha podido actualizar el cliente.');
  } finally {
    target.disabled = false;
  }
}

async function saveService(event) {
  event.preventDefault();
  try {
    const id = qs('#serviceIdEdit').value;
    const payload = {
      code: qs('#serviceCodeEdit').value.trim(),
      name: qs('#serviceNameEdit').value.trim(),
      unit: qs('#serviceUnitEdit').value.trim(),
      unit_price: Number(qs('#servicePriceEdit').value || 0),
      active: qs('#serviceActiveEdit').value === 'true',
    };
    const saved = await api(id ? `/api/config/services/${id}` : '/api/config/services', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    upsertStateRow('services', saved);
    toast('Servicio guardado.');
    clearServiceForm();
    renderServicesTable();
    fillDataLists();
  } catch (err) {
    toast(err.message || 'No se ha podido guardar el servicio.');
  }
}

async function saveUser(event) {
  event.preventDefault();
  try {
    const id = qs('#userIdEdit').value;
    const payload = {
      username: qs('#usernameEdit').value.trim(),
      password: qs('#userPasswordEdit').value,
      email: qs('#userEmailEdit').value.trim(),
      role: qs('#userRoleEdit').value.trim() || 'admin',
      active: qs('#userActiveEdit').value === 'true',
    };
    const saved = await api(id ? `/api/config/users/${id}` : '/api/config/users', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    upsertStateRow('users', saved);
    toast('Usuario guardado.');
    clearUserForm();
    renderUsersTable();
  } catch (err) {
    toast(err.message || 'No se ha podido guardar el usuario.');
  }
}

function bindConfigActions() {
  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.dataset.tab;
    if (tab) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn === target));
      document.querySelectorAll('.config-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${tab}Panel`));
    }
    const clientId = target.dataset.editClient;
    if (clientId) {
      const c = state.clients.find(row => String(row.id) === clientId);
      if (!c) return;
      qs('#clientIdEdit').value = c.id;
      qs('#clientCodeEdit').value = c.external_code || '';
      qs('#clientNameEdit').value = c.name || '';
      qs('#clientTaxEdit').value = c.tax_id || '';
      qs('#clientAddressEdit').value = c.address || '';
      qs('#clientPostalEdit').value = c.postal_code || '';
      qs('#clientCityEdit').value = c.city || '';
      qs('#clientProvinceEdit').value = c.province || '';
      qs('#clientPhoneEdit').value = c.phone || '';
      qs('#clientEmailEdit').value = c.email || '';
      qs('#clientPaymentEdit').value = c.default_payment_method || '';
      qs('#clientDeliveryEdit').value = c.default_delivery_method || '';
    }
    const labelClientId = target.dataset.printClientLabel;
    if (labelClientId) {
      const client = state.clients.find(row => String(row.id) === String(labelClientId));
      if (client) printClientLabel(client);
    }
    const serviceId = target.dataset.editService;
    if (serviceId) {
      const s = state.services.find(row => String(row.id) === serviceId);
      if (!s) return;
      qs('#serviceIdEdit').value = s.id;
      qs('#serviceCodeEdit').value = s.code || '';
      qs('#serviceNameEdit').value = s.name || '';
      qs('#serviceUnitEdit').value = s.unit || '';
      qs('#servicePriceEdit').value = s.unit_price || 0;
      qs('#serviceActiveEdit').value = s.active === false ? 'false' : 'true';
    }
    const userId = target.dataset.editUser;
    if (userId) {
      const u = state.users.find(row => String(row.id) === userId);
      if (!u) return;
      qs('#userIdEdit').value = u.id;
      qs('#usernameEdit').value = u.username || '';
      qs('#userPasswordEdit').value = '';
      qs('#userEmailEdit').value = u.email || '';
      qs('#userRoleEdit').value = u.role || 'admin';
      qs('#userActiveEdit').value = u.active === false ? 'false' : 'true';
    }
    const invoiceId = target.dataset.editInvoice;
    if (invoiceId) loadInvoiceIntoForm(invoiceId).catch(err => toast(err.message));
    const deleteInvoiceId = target.dataset.deleteInvoice;
    if (deleteInvoiceId) openDeleteInvoiceModal(deleteInvoiceId);
    for (const kind of ['Client', 'Service', 'User']) {
      const id = target.dataset[`delete${kind}`];
      if (id && confirm('Borrar registro?')) {
        try {
          await api(`/api/config/${kind.toLowerCase()}s/${id}`, { method: 'DELETE' });
          deleteStateRow(`${kind.toLowerCase()}s`, id);
          toast('Registro borrado.');
          if (kind === 'Client') renderClientsTable();
          if (kind === 'Service') {
            renderServicesTable();
            fillDataLists();
          }
          if (kind === 'User') renderUsersTable();
        } catch (err) {
          toast(err.message || 'No se ha podido borrar el registro.');
        }
      }
    }
  });
  document.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
    if (target.dataset.clientField) {
      await saveClientInline(target);
      return;
    }
    if (!(target instanceof HTMLSelectElement)) return;
    const statusInvoiceId = target.dataset.statusInvoice;
    if (!statusInvoiceId) return;
    try {
      const saved = await api(`/api/invoices/${statusInvoiceId}/status`, { method: 'PUT', body: JSON.stringify({ status: target.value }) });
      upsertStateRow('invoices', saved);
      toast('Estado actualizado.');
      renderInvoicesTable();
    } catch (err) {
      toast(err.message || 'No se ha podido actualizar el estado.');
    }
  });
}

async function handleLogin(event) {
  event.preventDefault();
  qs('#loginError').textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: qs('#loginUser').value, password: qs('#loginPassword').value }),
    });
    state.currentUser = data.user;
    sessionStorage.setItem(sessionUserKey, JSON.stringify(data.user));
    applySession();
    await loadAppData();
  } catch (err) {
    qs('#loginError').textContent = err.message;
  }
}

function applySession() {
  const logged = Boolean(state.currentUser);
  qs('#loginOverlay').classList.toggle('hidden', logged);
  const sessionUser = qs('#sessionUser');
  if (sessionUser) {
    sessionUser.textContent = logged ? `- ${state.currentUser.username} (${state.currentUser.email || 'sin email'})` : '';
  }
}

function applyDebugFlags() {
  if (urlParams.get('debugAddressBox') === '1') {
    document.body.classList.add('debug-address-box');
  }
  if (urlParams.get('debugLayout') === '1') {
    document.body.classList.add('debug-layout');
  }
}

async function loadAppData() {
  const data = await api('/api/bootstrap');
  state.clients = data.clients || [];
  state.services = data.services || [];
  state.clientPrices = data.client_prices || [];
  state.users = data.users || [];
  state.settings = data.settings || {};
  fillDataLists();
  const storageMode = qs('#storageMode');
  if (storageMode) {
    storageMode.textContent = data.storage === 'supabase' ? 'Conectado a Supabase' : 'Modo local JSON';
  }
  showInvoiceDate();
  updateInvoiceNumberDisplay();
  fillCounterForm();
  qs('#paymentMethodInput').value = state.settings.default_payment_method || qs('#paymentMethodInput').value;
  updatePrintTexts();
  restoreInvoiceDraft();
  setView(sessionStorage.getItem(viewKey) || 'invoice');
  syncNotesPrintState();
  calculateTotals();
  await loadLastInvoices();
}

async function init() {
  renderRows();
  applyDebugFlags();
  qs('#loginForm').addEventListener('submit', handleLogin);
  qs('#deleteInvoiceForm').addEventListener('submit', confirmDeleteInvoice);
  qs('#deleteInvoiceCancelBtn').addEventListener('click', closeDeleteInvoiceModal);
  qs('#logoutBtn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.currentUser = null;
    sessionStorage.removeItem(sessionUserKey);
    applySession();
  });
  qs('#invoiceViewBtn').addEventListener('click', () => setView('invoice'));
  qs('#configViewBtn').addEventListener('click', () => setView('config'));
  qs('#voiceBtn').addEventListener('click', () => qs('#voicePanel').classList.add('show'));
  qs('#voiceStartBtn').addEventListener('click', startVoiceAssistant);
  qs('#voiceRepeatBtn').addEventListener('click', askVoiceStep);
  qs('#voiceStopBtn').addEventListener('click', () => stopVoiceAssistant());
  qs('#voiceCloseBtn').addEventListener('click', () => {
    stopVoiceAssistant();
    qs('#voicePanel').classList.remove('show');
  });
  qs('#refreshConfigBtn').addEventListener('click', loadConfig);
  qs('#clientInput').addEventListener('change', selectClientByInput);
  qs('#clientInput').addEventListener('input', () => {
    selectClientByInput();
    openAutocomplete(qs('#clientInput'), 'client');
  });
  qs('#clientInput').addEventListener('focus', () => openAutocomplete(qs('#clientInput'), 'client'));
  document.addEventListener('mousedown', event => {
    if (!event.target.closest?.('.combo-menu') && !event.target.classList?.contains('combo-input')) closeAutocomplete();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAutocomplete();
  });
  qs('#paymentMethodInput').addEventListener('change', updatePrintTexts);
  qs('#deliveryMethodInput').addEventListener('change', updatePrintTexts);
  qs('#notesInput').addEventListener('input', syncNotesPrintState);
  qs('#invoiceTypeInput').addEventListener('change', updateInvoiceNumberDisplay);
  qs('#vatRateInput').addEventListener('change', calculateTotals);
  qs('#withholdingInput')?.addEventListener('change', calculateTotals);
  qs('#sequenceInput').addEventListener('input', () => qs('#sequencePrint').textContent = qs('#sequenceInput').value);
  qs('#invoiceView').addEventListener('input', saveInvoiceDraft);
  qs('#invoiceView').addEventListener('change', saveInvoiceDraft);
  qs('#printBtn').addEventListener('click', printInvoicePdf);
  qs('#registerBtn').addEventListener('click', registerInvoice);
  qs('#clearBtn').addEventListener('click', () => clearForm(true));
  qs('#addLineBtn').addEventListener('click', addLine);
  qs('#clientForm').addEventListener('submit', saveClient);
  qs('#serviceForm').addEventListener('submit', saveService);
  qs('#userForm').addEventListener('submit', saveUser);
  qs('#invoiceCounterForm').addEventListener('submit', saveInvoiceCounter);
  ['#counterYearEdit', '#counterPrefixEdit', '#counterSequenceEdit'].forEach(id => qs(id).addEventListener('input', updateCounterPreview));
  qs('#newClientBtn').addEventListener('click', clearClientForm);
  qs('#newServiceBtn').addEventListener('click', clearServiceForm);
  qs('#newUserBtn').addEventListener('click', clearUserForm);
  bindConfigSearches();
  window.addEventListener('beforeprint', () => {
    updatePrintTexts();
    syncNotesPrintState();
  });
  window.addEventListener('beforeunload', saveInvoiceDraft);
  bindConfigActions();
  try {
    const session = await api('/api/session');
    state.currentUser = session.user;
    sessionStorage.setItem(sessionUserKey, JSON.stringify(session.user));
    await loadAppData();
  } catch (_) {
    state.currentUser = null;
    sessionStorage.removeItem(sessionUserKey);
    const storageMode = qs('#storageMode');
    if (storageMode) {
      storageMode.textContent = 'Inicia sesion para cargar datos.';
    }
  }
  applySession();
}

init().catch(err => toast(err.message || 'No se pudo iniciar la aplicacion.'));
