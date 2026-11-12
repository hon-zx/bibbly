/* Glue between the Stick's platform modules and the app task in main.c. */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "sdkconfig.h"
#include "stick_device.h"

#define RING_LEDS CONFIG_BIBBLY_RING_LEDS

/* Bits the modules send to the app task (app_notify is safe from any task). */
#define APP_EVT_USB_RX (1u << 0)
#define APP_EVT_BLE_RX (1u << 1)
#define APP_EVT_USB (1u << 2)
#define APP_EVT_BLE (1u << 3)
#define APP_EVT_AUDIO (1u << 4)
void app_notify(uint32_t bits);

/* usb.c: TinyUSB composite device (UAC2 microphone, HID, vendor sync). */
void usb_start(const char *serial_hex);
bool usb_mounted(void);
bool usb_streaming(void);
bool usb_host_muted(void);
float usb_host_volume_db(void);
size_t usb_link_read(uint8_t *buf, size_t cap);
void usb_link_send(void *ctx, const uint8_t *bytes, size_t len);
void usb_mic_write(const int16_t *pcm, size_t samples);
void usb_hid_report(const uint8_t report[8]);

/* mic.c: PDM microphones -> DSP -> USB audio and the recorder. */
void mic_start(uint8_t mode);
void mic_set_mode(uint8_t mode);
void mic_set_muted(bool muted);
void mic_set_recording(bool on);
size_t mic_read_recording(int16_t *pcm, size_t max_samples);
int16_t mic_level_db10(void);

/* storage.c: microSD card and the recording key. */
bool storage_key(uint8_t key[32]);
stick_store_t *storage_start(stick_store_t *store, stick_cipher_t *cipher);
void storage_stop(stick_store_t *store);
void storage_space(void *ctx, uint64_t *total, uint64_t *free_bytes);

/* leds.c: the eyes and the ring. */
void leds_start(void);
void leds_show(const stick_rgb_t eyes[STICK_EYES], const stick_rgb_t *ring, size_t ring_n);
void leds_off(void);

/* ble.c: Bluetooth LE link to the phone. */
void ble_start(const char *name);
bool ble_link_connected(void);
size_t ble_link_read(uint8_t *buf, size_t cap);
void ble_link_send(void *ctx, const uint8_t *bytes, size_t len);

/* power.c: button, battery, USB power and deep sleep. */
void power_start(void);
bool power_button_pressed(void);
bool power_woke_by_button(void);
void power_read(uint8_t *pct, bool *charging);
void power_sleep(void);
