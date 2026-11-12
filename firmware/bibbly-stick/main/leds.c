/* Bibbly's eyes (two WS2812 LEDs) and the optional ring, driven over RMT. */
#include <string.h>

#include "bibbly.h"
#include "esp_log.h"
#include "led_strip.h"

#define LED_COUNT (STICK_EYES + RING_LEDS)

static led_strip_handle_t s_strip;
static stick_rgb_t s_last[LED_COUNT];
static bool s_valid;

void leds_start(void) {
  const led_strip_config_t strip = {
      .strip_gpio_num = CONFIG_BIBBLY_PIN_LEDS,
      .max_leds = LED_COUNT,
      .led_model = LED_MODEL_WS2812,
  };
  const led_strip_rmt_config_t rmt = {
      .clk_src = RMT_CLK_SRC_DEFAULT,
      .resolution_hz = 10 * 1000 * 1000,
  };
  if (led_strip_new_rmt_device(&strip, &rmt, &s_strip) != ESP_OK) {
    ESP_LOGE("leds", "no LED driver");
    s_strip = NULL;
    return;
  }
  led_strip_clear(s_strip);
}

static uint8_t dim(uint8_t v) { return (uint8_t)((uint32_t)v * CONFIG_BIBBLY_LED_BRIGHTNESS / 100); }

void leds_show(const stick_rgb_t eyes[STICK_EYES], const stick_rgb_t *ring, size_t ring_n) {
  if (!s_strip) return;
  stick_rgb_t frame[LED_COUNT];
  memcpy(frame, eyes, sizeof(stick_rgb_t) * STICK_EYES);
  for (size_t i = 0; i < RING_LEDS; i++) frame[STICK_EYES + i] = i < ring_n ? ring[i] : (stick_rgb_t){0, 0, 0};
  if (s_valid && memcmp(frame, s_last, sizeof(frame)) == 0) return; /* nothing changed: save power */
  for (size_t i = 0; i < LED_COUNT; i++) led_strip_set_pixel(s_strip, (uint32_t)i, dim(frame[i].r), dim(frame[i].g), dim(frame[i].b));
  led_strip_refresh(s_strip);
  memcpy(s_last, frame, sizeof(frame));
  s_valid = true;
}

void leds_off(void) {
  if (s_strip) led_strip_clear(s_strip);
  s_valid = false;
}
