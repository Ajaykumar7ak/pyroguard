
#include <DHT.h>

#define DHT_PIN     4
#define DHT_TYPE    DHT22

#define FLAME_PIN   27
#define BUZZER_PIN  26

DHT dht(DHT_PIN, DHT_TYPE);

unsigned long lastRead = 0;
const unsigned long READ_INTERVAL = 2000;

void setup() {
  Serial.begin(115200);

  pinMode(FLAME_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  // Active-LOW buzzer: HIGH = OFF
  digitalWrite(BUZZER_PIN, HIGH);

  dht.begin();
  delay(2000);

  // CSV header for future Python/database integration
  Serial.println(
    "uptime_ms,temperature_c,humidity_pct,"
    "flame_detected,buzzer_on,dht_ok"
  );
}

void loop() {
  if (millis() - lastRead < READ_INTERVAL) {
    return;
  }

  lastRead = millis();

  // Many LM393 flame modules output LOW when triggered.
  // Verify this behavior with your specific module.
  int flameState = digitalRead(FLAME_PIN);
  bool flameDetected = (flameState == LOW);

  // Active-LOW buzzer
  digitalWrite(BUZZER_PIN, flameDetected ? LOW : HIGH);
  bool buzzerOn = flameDetected;

  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();

  bool dhtOk = !isnan(temperature) && !isnan(humidity);

  // Machine-readable CSV: missing DHT readings become empty fields.
  Serial.print(millis());
  Serial.print(",");

  if (dhtOk) {
    Serial.print(temperature, 1);
    Serial.print(",");
    Serial.print(humidity, 1);
  } else {
    Serial.print(",");
  }

  Serial.print(",");
  Serial.print(flameDetected ? 1 : 0);
  Serial.print(",");
  Serial.print(buzzerOn ? 1 : 0);
  Serial.print(",");
  Serial.println(dhtOk ? 1 : 0);

  // Human-readable status
  Serial.print("Flame: ");
  Serial.print(flameDetected ? "DETECTED" : "NOT DETECTED");

  Serial.print(" | Buzzer: ");
  Serial.print(buzzerOn ? "ON" : "OFF");

  if (dhtOk) {
    Serial.printf(" | Temperature: %.1f C", temperature);
    Serial.printf(" | Humidity: %.1f %%", humidity);
  } else {
    Serial.print(" | DHT22 read failed");
  }

  Serial.println();
}
