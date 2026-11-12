/*
 * Bibbly Stick firmware entry point.
 *
 * One app task owns the portable device logic (components/stick_core) and
 * feeds it everything the hardware reports: bytes from the USB and Bluetooth
 * links, the button, audio for the recorder, USB and battery changes. The
 * microphone, USB and Bluetooth stacks run in their own tasks and wake the
 * app task with notification bits.
 */
#include <string.h>
#include <sys/time.h>

#include "bibbly.h"
#include "esp_app_desc.h"
#include "esp_flash.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "bibbly";

static TaskHandle_t s_app_task;
static stick_device_t s_dev;
static stick_store_t s_store;
static stick_cipher_t s_cipher;
static stick_link_t s_usb_link;
static stick_link_t s_ble_link;
static stick_identity_t s_identity;

/* Survives deep sleep and soft resets, not a power loss: has the app set the clock? */
static RTC_NOINIT_ATTR uint32_t s_clock_magic;
#define CLOCK_MAGIC 0xb1bb1e01u

void app_notify(uint32_t bits) {
  if (s_app_task) xTaskNotify(s_app_task, bits, eSetBits);
}

static uint32_t p_uptime(void *ctx) {
  (void)ctx;
  return (uint32_t)(esp_timer_get_time() / 1000);
}

static uint64_t p_epoch(void *ctx) {
  (void)ctx;
  if (s_clock_magic != CLOCK_MAGIC) return 0;
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000u + (uint64_t)(tv.tv_usec / 1000);
}

static void p_set_epoch(void *ctx, uint64_t ms) {
  (void)ctx;
  struct timeval tv = {.tv_sec = (time_t)(ms / 1000), .tv_usec = (suseconds_t)((ms % 1000) * 1000)};
  settimeofday(&tv, NULL);
  s_clock_magic = CLOCK_MAGIC;
}

static void save_mode(uint8_t mode) {
  nvs_handle_t h;
  if (nvs_open("bibbly", NVS_READWRITE, &h) != ESP_OK) return;
  nvs_set_u8(h, "mode", mode);
  nvs_commit(h);
  nvs_close(h);
}

static uint8_t load_mode(void) {
  nvs_handle_t h;
  uint8_t mode = STICK_MODE_MEETING_MIC;
  if (nvs_open("bibbly", NVS_READONLY, &h) == ESP_OK) {
    nvs_get_u8(h, "mode", &mode);
    nvs_close(h);
  }
  return mode < STICK_MODE_COUNT ? mode : STICK_MODE_MEETING_MIC;
}

static void p_on_mode(void *ctx, uint8_t mode) {
  (void)ctx;
  mic_set_mode(mode);
  save_mode(mode);
}

static void p_on_mute(void *ctx, bool muted) {
  (void)ctx;
  mic_set_muted(muted);
}

static void p_on_recording(void *ctx, bool on) {
  (void)ctx;
  mic_set_recording(on);
}

/* Mirrors link events on the HID interface, so WebHID pages see the button without the sync interface. */
static void p_on_event(void *ctx, uint8_t code, const uint8_t *payload, size_t len) {
  (void)ctx;
  uint8_t report[8] = {code};
  for (size_t i = 0; i < len && i < 3; i++) report[1 + i] = payload[i];
  report[4] = stick_device_state(&s_dev);
  report[5] = s_dev.mode;
  report[6] = s_dev.battery;
  report[7] = s_dev.muted ? STICK_FLAG_MUTED : 0;
  usb_hid_report(report);
}

static void random_fill(void *ctx, uint8_t *out, size_t len) {
  (void)ctx;
  esp_fill_random(out, len);
}

static void make_identity(char serial_hex[17]) {
  uint8_t mac[6] = {0};
  esp_efuse_mac_get_default(mac);
  s_identity.hardware = CONFIG_BIBBLY_HW_REV;
  s_identity.serial[0] = 0xbb;
  s_identity.serial[1] = (uint8_t)CONFIG_BIBBLY_HW_REV;
  memcpy(&s_identity.serial[2], mac, 6);
  for (int i = 0; i < 8; i++) snprintf(serial_hex + i * 2, 3, "%02x", s_identity.serial[i]);
  snprintf(s_identity.firmware, sizeof(s_identity.firmware), "%s", esp_app_get_description()->version);
  uint32_t flash = 0;
  esp_flash_get_size(NULL, &flash);
  s_identity.flash_kb = flash / 1024;
  s_identity.caps = STICK_CAP_USB_MIC | STICK_CAP_HID;
#if CONFIG_BIBBLY_BLE
  s_identity.caps |= STICK_CAP_BLE;
#endif
#if CONFIG_BIBBLY_BATTERY
  s_identity.caps |= STICK_CAP_BATTERY;
#endif
}

static void app_task(void *arg) {
  (void)arg;
  static uint8_t buf[1024];
  static int16_t pcm[1024];
  stick_rgb_t eyes[STICK_EYES], ring[RING_LEDS > 0 ? RING_LEDS : 1];
  uint32_t last_power = 0, last_leds = 0;
  bool usb_was = false;
  for (;;) {
    uint32_t bits = 0;
    xTaskNotifyWait(0, UINT32_MAX, &bits, pdMS_TO_TICKS(10));
    const uint32_t now = p_uptime(NULL);
    size_t n;

    if (bits & APP_EVT_USB) {
      const bool mounted = usb_mounted();
      stick_device_usb(&s_dev, mounted, usb_streaming());
      if (usb_was && !mounted) stick_device_link_state(&s_dev, &s_usb_link, false);
      usb_was = mounted;
    }
    if (bits & APP_EVT_BLE) stick_device_link_state(&s_dev, &s_ble_link, ble_link_connected());
    while ((n = usb_link_read(buf, sizeof(buf))) > 0) stick_device_rx(&s_dev, &s_usb_link, buf, n);
    while ((n = ble_link_read(buf, sizeof(buf))) > 0) stick_device_rx(&s_dev, &s_ble_link, buf, n);
    while ((n = mic_read_recording(pcm, sizeof(pcm) / sizeof(pcm[0]))) > 0) stick_device_audio(&s_dev, pcm, n);

    stick_device_level(&s_dev, mic_level_db10());
    stick_device_button(&s_dev, power_button_pressed());
    if (now - last_power >= 2000 || last_power == 0) {
      uint8_t pct;
      bool charging;
      power_read(&pct, &charging);
      stick_device_battery(&s_dev, pct, charging);
      last_power = now;
    }
    stick_device_tick(&s_dev);

    if (now - last_leds >= 20) {
      stick_device_render(&s_dev, eyes, ring, RING_LEDS);
      leds_show(eyes, ring, RING_LEDS);
      last_leds = now;
    }

    if (stick_device_idle_for(&s_dev, CONFIG_BIBBLY_SLEEP_MINUTES * 60000u) && !ble_link_connected()) {
      ESP_LOGI(TAG, "idle on battery: sleeping until the button is pressed or USB power returns");
      if (s_dev.store) storage_stop(s_dev.store);
      leds_off();
      power_sleep(); /* does not return */
    }
  }
}

void app_main(void) {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);

  power_start();
  const bool held = power_woke_by_button() && power_button_pressed();
  leds_start();

  char serial_hex[17];
  make_identity(serial_hex);
  const uint8_t mode = load_mode();

  uint8_t key[STICK_KEY_LEN];
  stick_cipher_t *cipher = NULL;
  if (storage_key(key) && stick_cipher_aes_init(&s_cipher, key, random_fill, NULL)) cipher = &s_cipher;
  memset(key, 0, sizeof(key));
  if (!cipher) ESP_LOGE(TAG, "no recording key: recordings will not be encrypted");
  stick_store_t *store = storage_start(&s_store, cipher);
  if (!store) ESP_LOGW(TAG, "no microSD card: working as a microphone only");

  const stick_platform_t platform = {
      .ctx = NULL,
      .uptime_ms = p_uptime,
      .epoch_ms = p_epoch,
      .set_epoch_ms = p_set_epoch,
      .space = store ? storage_space : NULL,
      .on_mode = p_on_mode,
      .on_mute = p_on_mute,
      .on_recording = p_on_recording,
      .on_event = p_on_event,
  };
  stick_device_init(&s_dev, &platform, &s_identity, store, mode, held);
  stick_device_attach(&s_dev, &s_usb_link, usb_link_send, NULL);
  stick_device_attach(&s_dev, &s_ble_link, ble_link_send, NULL);

  xTaskCreatePinnedToCore(app_task, "app", 8192, NULL, 5, &s_app_task, 1);
  mic_start(mode);
  usb_start(serial_hex);
#if CONFIG_BIBBLY_BLE
  char name[24];
  snprintf(name, sizeof(name), "Bibbly Stick %.4s", serial_hex + 12);
  ble_start(name);
#endif
  ESP_LOGI(TAG, "Bibbly Stick %s ready (serial %s, mode %u, %s)", s_identity.firmware, serial_hex, mode,
           store ? (cipher ? "encrypted card" : "card") : "no card");
}
