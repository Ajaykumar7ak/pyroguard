/*
 * ============================================================================
 * PYROGUARD-H | AI-Thinker ESP32-CAM MJPEG Video Streamer
 * ============================================================================
 * Hardware:
 *   - Board: AI-Thinker ESP32-CAM (OV2640 2MP Camera Sensor)
 *   - Flash LED: GPIO 4
 *
 * Flashing Instructions:
 *   1. Connect FTDI programmer: VCC -> 5V (or 3.3V), GND -> GND, TX -> U0R, RX -> U0T
 *   2. Connect GPIO 0 to GND before pressing reset or plugging in USB.
 *   3. Select Board: "AI Thinker ESP32-CAM", Partition: "Huge APP (3MB No OTA/1MB SPIFFS)"
 *   4. Flash code, then disconnect GPIO 0 from GND and press RST button.
 *   5. Open Serial Monitor at 115200 baud to view the assigned local IP address.
 *
 * Stream Endpoints:
 *   - Video Stream : http://<ESP32_CAM_IP>:81/stream  (or http://<ESP32_CAM_IP>/stream)
 *   - Snapshot     : http://<ESP32_CAM_IP>/capture
 *   - Flash LED    : http://<ESP32_CAM_IP>/led?state=1 (or 0)
 * ============================================================================
 */

#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"
#include "camera_pins.h"

// ----------------------------------------------------------------------------
// Network Configuration: UPDATE THESE WITH YOUR LOCAL WI-FI DETAILS
// ----------------------------------------------------------------------------
const char* ssid = "test";
const char* password = "12345678";

// Optional: Static IP configuration (leave commented to use DHCP)
/*
IPAddress local_IP(192, 168, 1, 50);
IPAddress gateway(192, 168, 1, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress primaryDNS(8, 8, 8, 8);
*/

httpd_handle_t stream_httpd = NULL;
httpd_handle_t camera_httpd = NULL;

#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {
  camera_fb_t * fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t * _jpg_buf = NULL;
  char * part_buf[64];

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) return res;

  // CORS headers
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "X-Framerate", "15");

  while (true) {
    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAM] Camera capture failed");
      res = ESP_FAIL;
    } else {
      _jpg_buf_len = fb->len;
      _jpg_buf = fb->buf;
    }

    if (res == ESP_OK) {
      size_t hlen = snprintf((char *)part_buf, 64, _STREAM_PART, _jpg_buf_len);
      res = httpd_resp_send_chunk(req, (const char *)part_buf, hlen);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char *)_jpg_buf, _jpg_buf_len);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    }

    if (fb) {
      esp_camera_fb_return(fb);
      fb = NULL;
      _jpg_buf = NULL;
    } else if (res != ESP_OK) {
      break;
    }
    vTaskDelay(pdMS_TO_TICKS(30)); // Cap at ~25-30 fps
  }
  return res;
}

static esp_err_t capture_handler(httpd_req_t *req) {
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t res = httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return res;
}

static esp_err_t status_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  String json = "{\"status\":\"ONLINE\",\"device\":\"PYROGUARD-CAM\",\"rssi\":" + String(WiFi.RSSI()) + "}";
  return httpd_resp_send(req, json.c_str(), json.length());
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;

  httpd_uri_t index_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t capture_uri = {
    .uri       = "/capture",
    .method    = HTTP_GET,
    .handler   = capture_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t status_uri = {
    .uri       = "/status",
    .method    = HTTP_GET,
    .handler   = status_handler,
    .user_ctx  = NULL
  };

  if (httpd_start(&camera_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(camera_httpd, &index_uri);
    httpd_register_uri_handler(camera_httpd, &capture_uri);
    httpd_register_uri_handler(camera_httpd, &status_uri);
  }

  // Also bind port 81 for /stream compatibility with standard ESP32 CameraWebServer sketch
  config.server_port = 81;
  config.ctrl_port = config.ctrl_port + 1;
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &index_uri);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== PYROGUARD-H ESP32-CAM Stream Node ===");

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;     // 640x480
  config.jpeg_quality = 12;              // 10-63 (lower = higher quality)
  config.fb_count = 2;

  // Initialize camera sensor
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM_ERR] Camera Init Failed with error 0x%x\n", err);
    return;
  }
  Serial.println("[CAM] Camera sensor initialized.");

  // Connect to Wi-Fi
  WiFi.begin(ssid, password);
  Serial.print("[WIFI] Connecting to ");
  Serial.print(ssid);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 40) {
    delay(500);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected successfully!");
    Serial.print("[WIFI] Assigned Local IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.printf("[STREAM] Main Stream URL: http://%s/stream\n", WiFi.localIP().toString().c_str());
    Serial.printf("[STREAM] Secondary Stream URL: http://%s:81/stream\n", WiFi.localIP().toString().c_str());
    Serial.printf("[STREAM] Snapshot URL: http://%s/capture\n", WiFi.localIP().toString().c_str());
    startCameraServer();
    Serial.println("[SERVER] Camera HTTP stream server running.");
  } else {
    Serial.println("\n[WIFI_ERR] Wi-Fi connection timed out. Check credentials.");
  }
}

void loop() {
  delay(10000);
}
