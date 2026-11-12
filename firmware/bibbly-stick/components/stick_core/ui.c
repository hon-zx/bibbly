#include "stick_ui.h"

#include <string.h>

#include "stick_link.h"

/* ---- Button ---------------------------------------------------------------- */

void stick_button_init(stick_button_t *b, bool pressed, uint32_t now_ms) {
  memset(b, 0, sizeof(*b));
  b->raw = b->stable = pressed;
  b->raw_since = b->press_at = now_ms;
}

uint8_t stick_button_update(stick_button_t *b, bool pressed, uint32_t now_ms) {
  if (pressed != b->raw) {
    b->raw = pressed;
    b->raw_since = now_ms;
  }
  if (b->raw != b->stable && (uint32_t)(now_ms - b->raw_since) >= STICK_BTN_DEBOUNCE_MS) {
    b->stable = b->raw;
    if (b->stable) {
      b->press_at = now_ms;
      b->long_fired = false;
    } else if (b->long_fired) {
      b->clicks = 0;
    } else {
      b->release_at = now_ms;
      if (++b->clicks >= 2) {
        b->clicks = 0;
        return STICK_GESTURE_DOUBLE;
      }
    }
  }
  if (b->stable && !b->long_fired && (uint32_t)(now_ms - b->press_at) >= STICK_BTN_LONG_MS) {
    b->long_fired = true;
    b->clicks = 0;
    return STICK_GESTURE_LONG;
  }
  if (!b->stable && b->clicks == 1 && (uint32_t)(now_ms - b->release_at) >= STICK_BTN_DOUBLE_GAP_MS) {
    b->clicks = 0;
    return STICK_GESTURE_SHORT;
  }
  return STICK_GESTURE_NONE;
}

/* ---- Lights ---------------------------------------------------------------- */

static const stick_rgb_t OFF = {0, 0, 0};
static const stick_rgb_t LAGOON = {69, 211, 182}; /* Bibbly's colour, --lagoon (dark theme) in the apps */
static const stick_rgb_t RED = {255, 0, 0};
static const stick_rgb_t AMBER = {255, 130, 0};
static const stick_rgb_t GREEN = {0, 210, 80};
static const stick_rgb_t BLUE = {40, 90, 255};
static const stick_rgb_t WHITE = {200, 200, 200};

static stick_rgb_t scale(stick_rgb_t c, uint32_t level) {
  if (level > 255) level = 255;
  stick_rgb_t o = {(uint8_t)(c.r * level / 255), (uint8_t)(c.g * level / 255), (uint8_t)(c.b * level / 255)};
  return o;
}

/* Triangle wave 0..255 with the given period. */
static uint32_t tri(uint32_t t, uint32_t period) {
  uint32_t phase = t % period, half = period / 2;
  return phase < half ? phase * 255 / half : (period - phase) * 255 / half;
}

static bool blink(uint32_t t, uint32_t on, uint32_t period) { return t % period < on; }

static stick_rgb_t wheel(uint32_t pos) {
  pos %= 768;
  if (pos < 256) return (stick_rgb_t){(uint8_t)(255 - pos), (uint8_t)pos, 0};
  if (pos < 512) return (stick_rgb_t){0, (uint8_t)(511 - pos), (uint8_t)(pos - 256)};
  return (stick_rgb_t){(uint8_t)(pos - 512), 0, (uint8_t)(767 - pos)};
}

void stick_lights_flash(stick_lights_t *l, uint8_t kind, uint8_t arg, uint32_t now_ms) {
  l->flash = kind;
  l->flash_arg = arg;
  l->flash_at = now_ms;
}

static stick_rgb_t battery_colour(uint8_t pct) {
  if (pct == STICK_BATTERY_NONE) return LAGOON;
  return pct > 50 ? GREEN : pct > 20 ? AMBER : RED;
}

/* Returns true and sets *c while an overlay is running. */
static bool overlay(stick_lights_t *l, uint32_t now, stick_rgb_t *c) {
  if (l->test) {
    uint32_t t = now - l->test_at;
    if (t >= 4000) {
      l->test = 0;
    } else {
      switch (l->test) {
        case 1: *c = wheel(t * 768 / 1500); return true;
        case 2: *c = t % 1500 < 500 ? RED : t % 1500 < 1000 ? (stick_rgb_t){0, 255, 0} : (stick_rgb_t){0, 0, 255}; return true;
        default: *c = blink(t, 250, 500) ? WHITE : OFF; return true;
      }
    }
  }
  if (l->flash == STICK_FLASH_NONE) return false;
  const uint32_t t = now - l->flash_at;
  uint32_t length = 0;
  stick_rgb_t colour = OFF;
  switch (l->flash) {
    case STICK_FLASH_ACK: length = 80; colour = WHITE; break;
    case STICK_FLASH_MODE:
      length = (uint32_t)(l->flash_arg + 1) * 300;
      colour = blink(t, 150, 300) ? WHITE : OFF;
      break;
    case STICK_FLASH_BATTERY: length = 1500; colour = battery_colour(l->battery); break;
    case STICK_FLASH_ERROR: length = 480; colour = t < 360 && blink(t, 120, 240) ? RED : OFF; break;
    case STICK_FLASH_REC_START: length = 300; colour = scale(RED, t * 255 / 300); break;
    case STICK_FLASH_REC_STOP: length = 600; colour = t < 450 && blink(t, 150, 300) ? GREEN : OFF; break;
    default: break;
  }
  if (t >= length) {
    l->flash = STICK_FLASH_NONE;
    return false;
  }
  *c = colour;
  return true;
}

void stick_lights_render(stick_lights_t *l, uint32_t now, stick_rgb_t eyes[STICK_EYES], stick_rgb_t *ring,
                         size_t ring_n) {
  stick_rgb_t c;
  if (overlay(l, now, &c)) {
    eyes[0] = eyes[1] = c;
    for (size_t i = 0; i < ring_n; i++) ring[i] = scale(c, 128);
    return;
  }
  eyes[0] = eyes[1] = OFF;
  size_t head = ring_n ? (size_t)((now / (1000 / (ring_n ? ring_n : 1))) % ring_n) : 0;
  switch (l->state) {
    case STICK_STATE_ERROR:
      eyes[0] = eyes[1] = blink(now, 125, 250) ? RED : OFF;
      break;
    case STICK_STATE_LOW_BATTERY:
      eyes[0] = eyes[1] = blink(now, 150, 2000) ? AMBER : OFF;
      break;
    case STICK_STATE_RECORDING:
      eyes[0] = eyes[1] = scale(RED, 80 + tri(now, 1000) * 175 / 255);
      for (size_t i = 0; i < ring_n; i++) {
        size_t behind = (head + ring_n - i) % ring_n;
        ring[i] = behind == 0 ? RED : behind <= 2 ? scale(RED, 90 / behind) : scale(RED, 12);
      }
      return;
    case STICK_STATE_SYNCING: {
      bool left = blink(now, 125, 250);
      eyes[0] = left ? BLUE : OFF;
      eyes[1] = left ? OFF : BLUE;
      for (size_t i = 0; i < ring_n; i++) ring[i] = i == head ? BLUE : scale(BLUE, 10);
      return;
    }
    case STICK_STATE_STREAMING:
      eyes[0] = eyes[1] = l->muted ? scale(RED, 60) : scale(LAGOON, 90);
      break;
    default: /* idle */
      if (l->usb) eyes[0] = eyes[1] = scale(LAGOON, 20 + tri(now, 4000) * 100 / 255);
      else eyes[0] = eyes[1] = blink(now, 120, 5000) ? scale(LAGOON, 40) : OFF; /* on battery: a slow "I'm alive" glint */
      if (l->usb && l->charging && l->battery != STICK_BATTERY_NONE && ring_n) {
        size_t lit = (ring_n * l->battery + 50) / 100;
        for (size_t i = 0; i < ring_n; i++) ring[i] = i < lit ? scale(GREEN, 40) : OFF;
        return;
      }
      break;
  }
  for (size_t i = 0; i < ring_n; i++) ring[i] = scale(eyes[0], 128);
}
