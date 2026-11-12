/*
 * The Stick's physical interface: one button and Bibbly's two "eye" lights,
 * plus an optional ring of lights around the button.
 *
 * Button gestures: short press, double press and long press (fires while the
 * button is still held, so the eyes can confirm the moment a recording starts).
 * Light patterns are a pure function of the device state and the time, so
 * they are unit-tested on the host.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define STICK_BTN_DEBOUNCE_MS 25
#define STICK_BTN_LONG_MS 1200
#define STICK_BTN_DOUBLE_GAP_MS 320

typedef struct {
  bool raw;
  bool stable;
  bool long_fired;
  uint8_t clicks;
  uint32_t raw_since;
  uint32_t press_at;
  uint32_t release_at;
} stick_button_t;

/* `pressed` is the level at start-up: true when the button woke the Stick and is still held. */
void stick_button_init(stick_button_t *b, bool pressed, uint32_t now_ms);
/* Feed the raw level every few milliseconds; returns a STICK_GESTURE_* or STICK_GESTURE_NONE. */
uint8_t stick_button_update(stick_button_t *b, bool pressed, uint32_t now_ms);

typedef struct {
  uint8_t r, g, b;
} stick_rgb_t;

#define STICK_EYES 2

enum {
  STICK_FLASH_NONE = 0,
  STICK_FLASH_ACK,        /* quick white blink: button heard */
  STICK_FLASH_MODE,       /* white blinks, one per mode number (1-3) */
  STICK_FLASH_BATTERY,    /* battery colour for 1.5 s: green, amber or red */
  STICK_FLASH_ERROR,      /* red double blink: no card, card full or write failed */
  STICK_FLASH_REC_START,  /* red swell: recording started */
  STICK_FLASH_REC_STOP,   /* green blink: recording saved */
};

typedef struct {
  /* Inputs, kept up to date by the device. */
  uint8_t state;   /* STICK_STATE_* */
  uint8_t mode;    /* STICK_MODE_* */
  uint8_t battery; /* percent, or STICK_BATTERY_NONE */
  bool charging;
  bool usb;
  bool muted;
  /* A one-off overlay animation. */
  uint8_t flash;
  uint8_t flash_arg;
  uint32_t flash_at;
  /* LED self-test from the app (STICK_CMD_LED_TEST), 0 = off. */
  uint8_t test;
  uint32_t test_at;
} stick_lights_t;

void stick_lights_flash(stick_lights_t *l, uint8_t kind, uint8_t arg, uint32_t now_ms);
/* Computes the eye colours (2) and, if ring_n > 0, the ring colours. */
void stick_lights_render(stick_lights_t *l, uint32_t now_ms, stick_rgb_t eyes[STICK_EYES], stick_rgb_t *ring,
                         size_t ring_n);

#ifdef __cplusplus
}
#endif
