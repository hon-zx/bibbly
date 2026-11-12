/*
 * Bibbly Stick link protocol v1: the byte protocol the Stick speaks over its
 * USB sync interface (WebUSB vendor bulk), Bluetooth LE and, in development,
 * the stdin/stdout of the host simulator.
 *
 * Frame: "BB" | ver u8 | type u8 | code u8 | seq u8 | len u16 LE | payload | crc32 u32 LE
 * The CRC (IEEE 802.3, the zlib CRC-32) covers ver..payload. Integers are
 * little-endian. Response payloads start with a status byte.
 *
 * Mirrors packages/core/src/stick/protocol.ts; keep the two in step.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define STICK_LINK_VERSION 1
#define STICK_LINK_HEADER 8
#define STICK_LINK_OVERHEAD 12
#define STICK_LINK_MAX_PAYLOAD 4096
#define STICK_LINK_MAX_FRAME (STICK_LINK_OVERHEAD + STICK_LINK_MAX_PAYLOAD)

enum { STICK_FRAME_REQUEST = 1, STICK_FRAME_RESPONSE = 2, STICK_FRAME_EVENT = 3 };

enum {
  STICK_CMD_PING = 0x01,
  STICK_CMD_INFO = 0x02,
  STICK_CMD_STATUS = 0x03,
  STICK_CMD_LIST = 0x04,
  STICK_CMD_READ = 0x05,
  STICK_CMD_DELETE = 0x06,
  STICK_CMD_SET_TIME = 0x07,
  STICK_CMD_SET_MODE = 0x08,
  STICK_CMD_RECORD = 0x09,
  STICK_CMD_LED_TEST = 0x0a,
  STICK_CMD_MARK_SYNCED = 0x0b,
};

enum { STICK_EVT_BUTTON = 0x81, STICK_EVT_STATE = 0x82, STICK_EVT_BATTERY = 0x83 };

enum {
  STICK_OK = 0,
  STICK_ERR_BAD_REQUEST = 1,
  STICK_ERR_NOT_FOUND = 2,
  STICK_ERR_BUSY = 3,
  STICK_ERR_IO = 4,
  STICK_ERR_UNSUPPORTED = 5,
};

enum {
  STICK_STATE_IDLE = 0,
  STICK_STATE_STREAMING = 1,
  STICK_STATE_RECORDING = 2,
  STICK_STATE_SYNCING = 3,
  STICK_STATE_LOW_BATTERY = 4,
  STICK_STATE_ERROR = 5,
};

enum { STICK_MODE_MEETING_MIC = 0, STICK_MODE_POCKET_RECORDER = 1, STICK_MODE_ROOM = 2, STICK_MODE_COUNT = 3 };

enum { STICK_GESTURE_NONE = 0, STICK_GESTURE_SHORT = 1, STICK_GESTURE_DOUBLE = 2, STICK_GESTURE_LONG = 3 };

/* Info.caps bits. */
#define STICK_CAP_USB_MIC (1u << 0)
#define STICK_CAP_HID (1u << 1)
#define STICK_CAP_BLE (1u << 2)
#define STICK_CAP_ENCRYPTED (1u << 3)
#define STICK_CAP_BATTERY (1u << 4)

/* Status.flags bits: an optional trailing byte; v1 readers that stop early ignore it. */
#define STICK_FLAG_MUTED (1u << 0)
#define STICK_FLAG_CLOCK_SET (1u << 1)
#define STICK_FLAG_ENCRYPTED (1u << 2)
#define STICK_FLAG_USB (1u << 3)
#define STICK_FLAG_NO_STORAGE (1u << 4)

/* Battery value meaning "no battery reading" (bus powered or no gauge). */
#define STICK_BATTERY_NONE 255

/* Size of one List entry: id u16, size u32, start u64, duration u32, flags u8, reserved u8. */
#define STICK_LIST_ENTRY 20
/* Bytes of Read response before the data: status u8, id u16, offset u32. */
#define STICK_READ_OVERHEAD 7

uint32_t stick_crc32_update(uint32_t crc, const uint8_t *data, size_t len);
uint32_t stick_crc32(const uint8_t *data, size_t len);

/* Encodes a frame into out (needs STICK_LINK_OVERHEAD + len bytes). Returns the frame size, or 0 if it doesn't fit. */
size_t stick_frame_encode(uint8_t *out, size_t cap, uint8_t type, uint8_t code, uint8_t seq, const uint8_t *payload,
                          size_t len);

typedef struct {
  uint8_t type;
  uint8_t code;
  uint8_t seq;
  uint16_t len;
  const uint8_t *payload;
} stick_frame_t;

typedef void (*stick_frame_cb)(void *ctx, const stick_frame_t *frame);

/* Incremental parser: resynchronises on the magic bytes and drops corrupt frames, like FrameParser in TypeScript. */
typedef struct {
  uint8_t buf[STICK_LINK_MAX_FRAME];
  size_t fill;
  uint32_t dropped;
} stick_parser_t;

void stick_parser_reset(stick_parser_t *p);
void stick_parser_push(stick_parser_t *p, const uint8_t *data, size_t len, stick_frame_cb cb, void *ctx);

/* Little-endian payload writer. Writes past the end set `overflow` instead of corrupting memory. */
typedef struct {
  uint8_t *buf;
  size_t cap;
  size_t len;
  bool overflow;
} stick_writer_t;

void stick_w_init(stick_writer_t *w, uint8_t *buf, size_t cap);
void stick_w_u8(stick_writer_t *w, uint8_t v);
void stick_w_u16(stick_writer_t *w, uint16_t v);
void stick_w_u32(stick_writer_t *w, uint32_t v);
void stick_w_u64(stick_writer_t *w, uint64_t v);
void stick_w_bytes(stick_writer_t *w, const void *data, size_t n);
/* Writes s NUL-padded (and truncated) to exactly n bytes. */
void stick_w_str(stick_writer_t *w, const char *s, size_t n);

/* Little-endian payload reader. Reads past the end return 0 and set `error`. */
typedef struct {
  const uint8_t *buf;
  size_t len;
  size_t pos;
  bool error;
} stick_reader_t;

void stick_r_init(stick_reader_t *r, const uint8_t *buf, size_t len);
uint8_t stick_r_u8(stick_reader_t *r);
uint16_t stick_r_u16(stick_reader_t *r);
uint32_t stick_r_u32(stick_reader_t *r);
uint64_t stick_r_u64(stick_reader_t *r);

#ifdef __cplusplus
}
#endif
