#include "stick_link.h"
#include "stick_ui.h"
#include "test.h"

/* Holds the button at `level` from t to t+ms, sampling every 5 ms; returns the first gesture seen. */
static uint8_t hold(stick_button_t *b, bool level, uint32_t *t, uint32_t ms, uint32_t *at) {
  uint8_t g = STICK_GESTURE_NONE;
  for (uint32_t end = *t + ms; *t < end; *t += 5) {
    uint8_t x = stick_button_update(b, level, *t);
    if (x && !g) {
      g = x;
      if (at) *at = *t;
    }
  }
  return g;
}

static bool is(stick_rgb_t c, uint8_t r, uint8_t g, uint8_t b) { return c.r == r && c.g == g && c.b == b; }

void test_ui(void) {
  stick_button_t b;
  uint32_t t = 1000, at = 0;

  /* Short press: reported once the double-press window has passed. */
  stick_button_init(&b, false, t);
  CHECK_EQ(hold(&b, true, &t, 120, NULL), STICK_GESTURE_NONE);
  CHECK_EQ(hold(&b, false, &t, 200, NULL), STICK_GESTURE_NONE);
  CHECK_EQ(hold(&b, false, &t, 300, NULL), STICK_GESTURE_SHORT);

  /* Double press, and no stray short press after it. */
  hold(&b, true, &t, 100, NULL);
  hold(&b, false, &t, 120, NULL);
  CHECK_EQ(hold(&b, true, &t, 100, NULL), STICK_GESTURE_NONE);
  CHECK_EQ(hold(&b, false, &t, 50, NULL), STICK_GESTURE_DOUBLE);
  CHECK_EQ(hold(&b, false, &t, 600, NULL), STICK_GESTURE_NONE);

  /* Long press fires while still held, at debounce + 1.2 s; releasing adds nothing. */
  uint32_t pressed_at = t;
  CHECK_EQ(hold(&b, true, &t, 1500, &at), STICK_GESTURE_LONG);
  CHECK(at - pressed_at >= STICK_BTN_LONG_MS && at - pressed_at <= STICK_BTN_LONG_MS + STICK_BTN_DEBOUNCE_MS + 5);
  CHECK_EQ(hold(&b, false, &t, 800, NULL), STICK_GESTURE_NONE);

  /* Contact bounce counts as one press. */
  for (int i = 0; i < 4; i++) stick_button_update(&b, i % 2 == 0, t), t += 5;
  CHECK_EQ(hold(&b, true, &t, 100, NULL), STICK_GESTURE_NONE);
  CHECK_EQ(hold(&b, false, &t, 500, NULL), STICK_GESTURE_SHORT);

  /* Woken by a press that is still held: the long press still counts (one-touch record from sleep). */
  t = 50;
  stick_button_init(&b, true, t);
  CHECK_EQ(hold(&b, true, &t, 1300, NULL), STICK_GESTURE_LONG);

  /* Lights. */
  stick_lights_t l = {0};
  stick_rgb_t eyes[2], ring[12];
  l.battery = STICK_BATTERY_NONE;
  l.state = STICK_STATE_RECORDING;
  stick_lights_render(&l, 250, eyes, ring, 12);
  CHECK(eyes[0].r > 0 && eyes[0].g == 0 && eyes[0].b == 0);
  int bright = 0;
  for (int i = 0; i < 12; i++) bright += ring[i].r == 255;
  CHECK_EQ(bright, 1); /* one spinner head */

  l.state = STICK_STATE_SYNCING;
  stick_lights_render(&l, 10, eyes, ring, 0);
  CHECK(eyes[0].b > 0 && is(eyes[1], 0, 0, 0));
  stick_lights_render(&l, 135, eyes, ring, 0);
  CHECK(is(eyes[0], 0, 0, 0) && eyes[1].b > 0);

  l.state = STICK_STATE_IDLE;
  l.usb = false;
  stick_lights_render(&l, 2000, eyes, ring, 0);
  CHECK(is(eyes[0], 0, 0, 0)); /* on battery the eyes rest */

  /* Mode flash: mode 2 blinks three times, then the state pattern returns. */
  stick_lights_flash(&l, STICK_FLASH_MODE, 2, 10000);
  int on = 0;
  for (uint32_t dt = 75; dt < 900; dt += 150) {
    stick_lights_render(&l, 10000 + dt, eyes, ring, 0);
    on += eyes[0].r == 200 && eyes[0].g == 200;
  }
  CHECK_EQ(on, 3);
  stick_lights_render(&l, 10950, eyes, ring, 0);
  CHECK_EQ(l.flash, STICK_FLASH_NONE);

  /* Battery check colours. */
  l.battery = 64;
  stick_lights_flash(&l, STICK_FLASH_BATTERY, 0, 20000);
  stick_lights_render(&l, 20100, eyes, ring, 0);
  CHECK(eyes[0].g > eyes[0].r);
  l.battery = 12;
  stick_lights_flash(&l, STICK_FLASH_BATTERY, 0, 30000);
  stick_lights_render(&l, 30100, eyes, ring, 0);
  CHECK(is(eyes[0], 255, 0, 0));

  /* LED self-test runs for four seconds. */
  l.test = 2;
  l.test_at = 40000;
  stick_lights_render(&l, 40100, eyes, ring, 0);
  CHECK(is(eyes[0], 255, 0, 0));
  stick_lights_render(&l, 40600, eyes, ring, 0);
  CHECK(is(eyes[0], 0, 255, 0));
  stick_lights_render(&l, 44100, eyes, ring, 0);
  CHECK_EQ(l.test, 0);
}
