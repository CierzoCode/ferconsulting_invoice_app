/*
  Simulador Wokwi de la placa ESP32 del atomizador.

  Controles:
  - Potenciómetro azul: presión ramal 1 (0-25 bar)
  - Potenciómetro verde: presión ramal 2 (0-25 bar)
  - Potenciómetro naranja: caudal total (0-80 L/min)
  - Potenciómetro violeta: velocidad (0-15 km/h)
  - Pulsador: bomba ON/OFF

  La placa se conecta a Wokwi-GUEST y envía el mismo JSON que la aplicación.
  Cambia API_URL por la IP/URL accesible de tu servidor Flask.
*/

#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";
const char* API_URL = "http://192.168.1.100:5055/api/telemetry";
const char* API_KEY = "";

constexpr int PRESSURE_1_PIN = 34;
constexpr int PRESSURE_2_PIN = 35;
constexpr int FLOW_POT_PIN = 32;
constexpr int SPEED_POT_PIN = 33;
constexpr int PUMP_BUTTON_PIN = 25;
constexpr int STATUS_LED_PIN = 2;

constexpr float PRESSURE_MAX_BAR = 25.0f;
constexpr float FLOW_MAX_L_MIN = 80.0f;
constexpr float SPEED_MAX_KMH = 15.0f;
constexpr unsigned long SEND_INTERVAL_MS = 1000;

bool pumpOn = true;
bool lastButtonState = HIGH;
unsigned long lastDebounceMs = 0;
unsigned long lastSendMs = 0;
uint32_t sequenceNumber = 0;
float latitude = 41.6488000f;
float longitude = -0.8891000f;
float headingDegrees = 35.0f;

float readScaled(int pin, float maximum) {
  const int raw = analogRead(pin);
  return (raw / 4095.0f) * maximum;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Conectando a WiFi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 12000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi conectado. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("No se pudo conectar a WiFi");
  }
}

void updatePumpButton() {
  const bool buttonState = digitalRead(PUMP_BUTTON_PIN);
  if (buttonState != lastButtonState && millis() - lastDebounceMs > 40) {
    lastDebounceMs = millis();
    lastButtonState = buttonState;
    if (buttonState == LOW) {
      pumpOn = !pumpOn;
      Serial.printf("Bomba: %s\n", pumpOn ? "ON" : "OFF");
    }
  }
  digitalWrite(STATUS_LED_PIN, pumpOn ? HIGH : LOW);
}

void updateSimulatedGps(float speedKmh, float elapsedSeconds) {
  const float distanceM = (speedKmh / 3.6f) * elapsedSeconds;
  const float headingRad = headingDegrees * PI / 180.0f;
  latitude += (distanceM * cos(headingRad)) / 111320.0f;
  const float longitudeScale = 111320.0f * max(0.1f, cos(latitude * PI / 180.0f));
  longitude += (distanceM * sin(headingRad)) / longitudeScale;
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  pinMode(PUMP_BUTTON_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH);

  Serial.println("Atomizador ESP32 · simulador Wokwi");
  connectWiFi();
  lastSendMs = millis();
}

void loop() {
  updatePumpButton();

  const unsigned long now = millis();
  if (now - lastSendMs < SEND_INTERVAL_MS) {
    delay(5);
    return;
  }

  const float elapsedSeconds = (now - lastSendMs) / 1000.0f;
  lastSendMs = now;

  float pressure1 = readScaled(PRESSURE_1_PIN, PRESSURE_MAX_BAR);
  float pressure2 = readScaled(PRESSURE_2_PIN, PRESSURE_MAX_BAR);
  float flow = readScaled(FLOW_POT_PIN, FLOW_MAX_L_MIN);
  float speed = readScaled(SPEED_POT_PIN, SPEED_MAX_KMH);

  if (!pumpOn) {
    pressure1 = 0.0f;
    pressure2 = 0.0f;
    flow = 0.0f;
  }

  updateSimulatedGps(speed, elapsedSeconds);
  sequenceNumber++;

  String payload = "{";
  payload += "\"pressure_1_bar\":" + String(pressure1, 2) + ",";
  payload += "\"pressure_2_bar\":" + String(pressure2, 2) + ",";
  payload += "\"flow_l_min\":" + String(flow, 2) + ",";
  payload += "\"speed_kmh\":" + String(speed, 2) + ",";
  payload += "\"latitude\":" + String(latitude, 7) + ",";
  payload += "\"longitude\":" + String(longitude, 7) + ",";
  payload += "\"source\":\"esp32-wokwi\",";
  payload += "\"sequence\":" + String(sequenceNumber);
  payload += "}";

  Serial.println(payload);

  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");
  if (strlen(API_KEY) > 0) http.addHeader("X-API-Key", API_KEY);
  const int statusCode = http.POST(payload);
  Serial.printf("HTTP %d\n", statusCode);
  if (statusCode > 0) Serial.println(http.getString());
  http.end();
}
