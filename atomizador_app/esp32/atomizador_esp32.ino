/*
  Ejemplo de telemetría para la app Atomizador.

  Hardware previsto:
  - ESP32
  - 1 o 2 sensores de presión 4-20 mA con resistencia shunt de 150 ohm
    (4 mA = 0,6 V; 20 mA = 3,0 V)
  - Caudalímetro con salida de pulsos
  - GPS NEO-6M/NEO-M8N por UART (opcional)

  IMPORTANTE:
  - Ajusta PRESSURE_MAX_BAR y FLOW_PULSES_PER_LITER a tus sensores reales.
  - Añade protección eléctrica y masa común.
  - El ESP32 no admite directamente 12 V ni señales superiores a 3,3 V.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <TinyGPSPlus.h>

const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_CLAVE";
const char* API_URL = "http://192.168.1.100:5055/api/telemetry";
const char* CONTROL_URL = "http://192.168.1.100:5055/api/control";
const char* API_KEY = ""; // Debe coincidir con ATOMIZADOR_API_KEY; déjalo vacío si no se usa.

constexpr int PRESSURE_1_PIN = 34;
constexpr int PRESSURE_2_PIN = 35;
constexpr int FLOW_PIN = 27;
constexpr int GPS_RX_PIN = 16;
constexpr int GPS_TX_PIN = 17;
constexpr int LEFT_VALVE_PIN = 25;
constexpr int RIGHT_VALVE_PIN = 26;
constexpr bool VALVE_ACTIVE_HIGH = true; // Pon false si tu módulo de relés se activa con nivel bajo.

constexpr float SHUNT_OHMS = 150.0f;
constexpr float PRESSURE_MAX_BAR = 25.0f;
constexpr float FLOW_PULSES_PER_LITER = 450.0f; // Cambiar según el caudalímetro.
constexpr unsigned long SEND_INTERVAL_MS = 1000;

volatile uint32_t flowPulses = 0;
unsigned long lastSendMs = 0;
unsigned long lastFlowMs = 0;
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

void IRAM_ATTR onFlowPulse() {
  flowPulses++;
}

float readPressureBar(int pin) {
  // Promedio simple para reducir ruido.
  uint32_t sum = 0;
  constexpr int samples = 32;
  for (int i = 0; i < samples; ++i) {
    sum += analogReadMilliVolts(pin);
    delayMicroseconds(250);
  }

  const float voltage = (sum / static_cast<float>(samples)) / 1000.0f;
  const float currentA = voltage / SHUNT_OHMS;
  const float currentmA = currentA * 1000.0f;

  // Conversión lineal: 4-20 mA -> 0-PRESSURE_MAX_BAR.
  float pressure = (currentmA - 4.0f) * PRESSURE_MAX_BAR / 16.0f;
  if (pressure < 0.0f) pressure = 0.0f;
  if (pressure > PRESSURE_MAX_BAR * 1.1f) pressure = PRESSURE_MAX_BAR * 1.1f;
  return pressure;
}

float readFlowLitersPerMinute(unsigned long nowMs) {
  noInterrupts();
  const uint32_t pulses = flowPulses;
  flowPulses = 0;
  interrupts();

  const unsigned long elapsedMs = nowMs - lastFlowMs;
  lastFlowMs = nowMs;
  if (elapsedMs == 0 || FLOW_PULSES_PER_LITER <= 0) return 0.0f;

  const float liters = pulses / FLOW_PULSES_PER_LITER;
  return liters * 60000.0f / elapsedMs;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP ESP32: ");
  Serial.println(WiFi.localIP());
}

void setValve(int pin, bool enabled) {
  digitalWrite(pin, enabled == VALVE_ACTIVE_HIGH ? HIGH : LOW);
}

void updateSprayerControl() {
  HTTPClient http;
  http.begin(CONTROL_URL);
  if (strlen(API_KEY) > 0) http.addHeader("X-API-Key", API_KEY);
  const int statusCode = http.GET();
  if (statusCode == 200) {
    const String response = http.getString();
    // La respuesta es compacta y Flask serializa los booleanos como true/false.
    const bool leftEnabled = response.indexOf("\"left_enabled\":true") >= 0;
    const bool rightEnabled = response.indexOf("\"right_enabled\":true") >= 0;
    setValve(LEFT_VALVE_PIN, leftEnabled);
    setValve(RIGHT_VALVE_PIN, rightEnabled);
  } else {
    // Estado seguro si se pierde el mando remoto.
    setValve(LEFT_VALVE_PIN, false);
    setValve(RIGHT_VALVE_PIN, false);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  pinMode(PRESSURE_1_PIN, INPUT);
  pinMode(PRESSURE_2_PIN, INPUT);
  pinMode(FLOW_PIN, INPUT_PULLUP);
  pinMode(LEFT_VALVE_PIN, OUTPUT);
  pinMode(RIGHT_VALVE_PIN, OUTPUT);
  setValve(LEFT_VALVE_PIN, false);
  setValve(RIGHT_VALVE_PIN, false);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onFlowPulse, FALLING);

  gpsSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  connectWiFi();

  lastSendMs = millis();
  lastFlowMs = lastSendMs;
}

void loop() {
  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
  }

  const unsigned long nowMs = millis();
  if (nowMs - lastSendMs < SEND_INTERVAL_MS) return;
  lastSendMs = nowMs;

  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  const float pressure1 = readPressureBar(PRESSURE_1_PIN);
  const float pressure2 = readPressureBar(PRESSURE_2_PIN);
  const float flowLMin = readFlowLitersPerMinute(nowMs);
  const float speedKmh = gps.speed.isValid() ? gps.speed.kmph() : 0.0f;
  const bool hasLocation = gps.location.isValid() && gps.location.age() < 5000;

  String payload = "{";
  payload += "\"pressure_1_bar\":" + String(pressure1, 2) + ",";
  payload += "\"pressure_2_bar\":" + String(pressure2, 2) + ",";
  payload += "\"flow_l_min\":" + String(flowLMin, 2) + ",";
  payload += "\"speed_kmh\":" + String(speedKmh, 2) + ",";
  if (hasLocation) {
    payload += "\"latitude\":" + String(gps.location.lat(), 7) + ",";
    payload += "\"longitude\":" + String(gps.location.lng(), 7) + ",";
  }
  payload += "\"source\":\"esp32\"";
  payload += "}";

  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  if (strlen(API_KEY) > 0) {
    http.addHeader("X-API-Key", API_KEY);
  }

  const int statusCode = http.POST(payload);
  Serial.printf("POST %d | %s\n", statusCode, payload.c_str());
  if (statusCode > 0) {
    Serial.println(http.getString());
  }
  http.end();
  updateSprayerControl();
}
