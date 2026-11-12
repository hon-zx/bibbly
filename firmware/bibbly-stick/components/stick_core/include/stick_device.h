/*
 * The Stick's behaviour, independent of the hardware: link commands, button
 * gestures, recording, modes, battery and the state shown on the eyes.
 *
 * The ESP-IDF firmware (main/) and the host simulator (host/) both drive this
 * from a single task: they feed it bytes from each link, button levels, audio,
 * USB and battery changes, and call stick_device_tick() every 10-20 ms. It
 * never blocks except on storage writes.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "stick_link.h"
#include "stick_store.h"
#include "stick_ui.h"

#ifdef __cplusplus
extern "C" {
#endif

#define STICK_MAX_LINKS 2
#define STICK_MIN_FREE_TO_RECORD (1024u * 1024u) /* refuse to start below 1 MB free */
#define STICK_MIN_FREE_RECORDING (256u * 1024u)  /* stop and save below 256 KB free */
#define STICK_FLUSH_EVERY_MS 10000
#define STICK_SYNC_LINGER_MS 1500
#define STICK_LOW_BATTERY_PCT 5

typedef struct {
  void *ctx;
  uint32_t (*uptime_ms)(void *ctx);
  uint64_t (*epoch_ms)(void *ctx); /* wall-clock time, or 0 when it has never been set */
  void (*set_epoch_ms)(void *ctx, uint64_t epoch_ms);
  void (*space)(void *ctx, uint64_t *total_bytes, uint64_t *free_bytes); /* optional */
  void (*on_mode)(void *ctx, uint8_t mode);           /* optional: persist and retune the microphones */
  void (*on_mute)(void *ctx, bool muted);             /* optional */
  void (*on_recording)(void *ctx, bool recording);    /* optional: start or stop feeding stick_device_audio */
  void (*on_event)(void *ctx, uint8_t code, const uint8_t *payload, size_t len); /* optional: mirror to HID */
} stick_platform_t;

typedef struct {
  uint16_t hardware;
  char firmware[16];
  uint8_t serial[8];
  uint32_t caps;
  uint32_t flash_kb;
} stick_identity_t;

struct stick_device;

/* One byte-stream connection to an app: USB sync interface, Bluetooth LE or the simulator's stdio. */
typedef struct stick_link {
  void (*send)(void *ctx, const uint8_t *bytes, size_t len);
  void *ctx;
  bool connected;
  struct stick_device *dev;
  stick_parser_t parser;
} stick_link_t;

typedef struct stick_device {
  stick_platform_t p;
  stick_identity_t id;
  stick_store_t *store; /* NULL when there is no card */
  stick_recorder_t rec;
  stick_link_t *links[STICK_MAX_LINKS];
  size_t n_links;
  stick_lights_t lights;
  stick_button_t button;
  uint8_t mode;
  uint8_t state; /* last state announced in a State event */
  bool usb;
  bool streaming;
  bool muted;
  bool fault;
  uint8_t battery;
  bool charging;
  uint8_t evt_battery;
  bool evt_charging;
  uint32_t evt_battery_at;
  int16_t level_db10;
  uint32_t sync_until;
  uint32_t last_activity;
  uint32_t flushed_at;
  uint8_t evt_seq;
  uint8_t out[STICK_LINK_MAX_FRAME];
} stick_device_t;

void stick_device_init(stick_device_t *d, const stick_platform_t *p, const stick_identity_t *id, stick_store_t *store,
                       uint8_t mode, bool button_held);
void stick_device_attach(stick_device_t *d, stick_link_t *l, void (*send)(void *ctx, const uint8_t *bytes, size_t len),
                         void *ctx);
void stick_device_link_state(stick_device_t *d, stick_link_t *l, bool connected);
void stick_device_rx(stick_device_t *d, stick_link_t *l, const uint8_t *bytes, size_t len);

/* Raw button level; call every 5-10 ms. */
void stick_device_button(stick_device_t *d, bool pressed);
/* A gesture recognised elsewhere (the simulator's signals). */
void stick_device_gesture(stick_device_t *d, uint8_t gesture);
/* Mono 16 kHz audio for the recorder (only needed while recording). */
void stick_device_audio(stick_device_t *d, const int16_t *pcm, size_t n);
void stick_device_level(stick_device_t *d, int16_t level_db10);
void stick_device_usb(stick_device_t *d, bool connected, bool streaming);
void stick_device_battery(stick_device_t *d, uint8_t pct, bool charging);
void stick_device_fault(stick_device_t *d, bool fault);
void stick_device_tick(stick_device_t *d);

int stick_device_record(stick_device_t *d, bool start, uint16_t *id);
int stick_device_set_mode(stick_device_t *d, uint8_t mode);
uint8_t stick_device_state(const stick_device_t *d);
bool stick_device_recording(const stick_device_t *d);
/* True when nothing has happened for `ms` while unplugged and not recording: time to sleep. */
bool stick_device_idle_for(const stick_device_t *d, uint32_t ms);
void stick_device_render(stick_device_t *d, stick_rgb_t eyes[STICK_EYES], stick_rgb_t *ring, size_t ring_n);

#ifdef __cplusplus
}
#endif
