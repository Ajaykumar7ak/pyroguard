/*
 * ============================================================================
 * PYROGUARD-H | Sensor Node Firmware (ESP32)
 * ============================================================================
 * Hardware Configuration:
 *   - Microcontroller : ESP32 DevKit V1 (30-pin or 38-pin)
 *   - Temperature/RH  : DHT22 (AM2302) Sensor on GPIO 4
 *   - Flame Sensor    : IR Flame Sensor Module (Digital OUT on GPIO 14, Analog OUT on GPIO 34)
 *   - Warning Buzzer  : Active 5V/3.3V Buzzer on GPIO 12
 *   - Status LED      : Onboard LED on GPIO 2
 *
 * Serial Configuration:
 *   - Baud Rate       : 115200 baud (8-N-1)
 *   - Protocol        : Newline-delimited JSON messages (NDJSON)
 *   - Telemetry Rate  : 1 Hz (1000 ms interval)
 *
 * Incoming Serial Commands (ended with newline):
 *   - "PING"          -> Returns {"response":"PONG"}
 *   - "BUZZ_TEST"     -> Beeps buzzer for 500ms
 *   - "STATUS"        -> Returns immediate telemetry packet
 * ============================================================================
 */

#include <Arduino.h>
#include <DHT.h>

// Pin Definitions
#define DHT_PIN         4
#define DHT_TYPE        DHT22

#define FLAME_DO_PIN    14    // Digital threshold pin (LOW when flame detected on most modules)
#define FLAME_AO_PIN    34    // ADC pin for analog intensity reading
#define BUZZER_PIN      12    // Warning buzzer
#define STATUS_LED_PIN  2     // Onboard status indicator

// Sensor Objects
DHT dht(DHT_PIN, DHT_TYPE);

// Device Metadata
const char* DEVICE_ID = "PYRO-ESP32-01";
const char* FIRMWARE_VER = "1.0.0-phase1";

// Timing variables
unsigned long lastTelemetryTime = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 1000;
unsigned long packetCounter = 0;

void setup() {
  // Initialize Serial interface at default 115200 baud
  Serial.begin(115200);
  delay(100);

  // Initialize GPIO pins
  pinMode(FLAME_DO_PIN, INPUT_PULLUP);
  pinMode(FLAME_AO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(STATUS_LED_PIN, LOW);

  // Initialize DHT sensor
  dht.begin();

  // Initial startup announcement
  digitalWrite(STATUS_LED_PIN, HIGH);
  delay(200);
  digitalWrite(STATUS_LED_PIN, LOW);

  Serial.println();
  Serial.println("{\"event\":\"system_ready\",\"device_id\":\"" + String(DEVICE_ID) + "\",\"firmware\":\"" + String(FIRMWARE_VER) + "\",\"baud\":115200}");
}

void loop() {
  unsigned long now = millis();

  // Process incoming commands from USB Serial (from Web Serial or Python collector)
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd.equalsIgnoreCase("PING")) {
      Serial.println("{\"response\":\"PONG\",\"timestamp_ms\":" + String(now) + "}");
    } else if (cmd.equalsIgnoreCase("BUZZ_TEST")) {
      digitalWrite(BUZZER_PIN, HIGH);
      digitalWrite(STATUS_LED_PIN, HIGH);
      delay(300);
      digitalWrite(BUZZER_PIN, LOW);
      digitalWrite(STATUS_LED_PIN, LOW);
      Serial.println("{\"response\":\"BUZZ_TEST_OK\"}");
    } else if (cmd.equalsIgnoreCase("STATUS")) {
      sendTelemetry(now);
    }
  }

  // Periodic Telemetry Transmission (1 Hz)
  if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = now;
    sendTelemetry(now);
  }
}

void sendTelemetry(unsigned long now) {
  packetCounter++;

  // Read DHT22
  float tempC = dht.readTemperature();
  float humidity = dht.readHumidity();

  // Read Flame Sensor
  // Most IR flame sensors pull DO LOW when infrared fire flicker is detected
  int flameDigital = digitalRead(FLAME_DO_PIN);
  bool flameDetected = (flameDigital == LOW);
  int flameRawAnalog = analogRead(FLAME_AO_PIN);

  // Sensor reading validation
  bool dhtError = isnan(tempC) || isnan(humidity);
  if (dhtError) {
    tempC = 0.0;
    humidity = 0.0;
  }

  // Active warning indication
  bool buzzerActive = false;
  if (flameDetected || (!dhtError && tempC > 55.0)) {
    buzzerActive = true;
    digitalWrite(BUZZER_PIN, HIGH);
    digitalWrite(STATUS_LED_PIN, HIGH);
  } else {
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(STATUS_LED_PIN, LOW);
  }

  // Construct structured JSON payload
  // Avoid heavy JSON library to preserve flash & ensure fast non-blocking output
  String json = "{";
  json += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  json += "\"packet_id\":" + String(packetCounter) + ",";
  json += "\"uptime_s\":" + String(now / 1000) + ",";
  json += "\"temp_c\":" + (dhtError ? String("null") : String(tempC, 2)) + ",";
  json += "\"humidity_pct\":" + (dhtError ? String("null") : String(humidity, 2)) + ",";
  json += "\"flame_detected\":" + String(flameDetected ? "true" : "false") + ",";
  json += "\"flame_raw\":" + String(flameRawAnalog) + ",";
  json += "\"buzzer_active\":" + String(buzzerActive ? "true" : "false") + ",";
  json += "\"sensor_status\":\"" + String(dhtError ? "DHT_ERROR" : "NORMAL") + "\"";
  json += "}";

  Serial.println(json);
}
