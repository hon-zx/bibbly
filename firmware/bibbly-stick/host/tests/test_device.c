/* Drives the device over its link exactly as an app would, with a fake clock. */
#include <stdlib.h>

#include "stick_device.h"
#include "synth.h"
#include "test.h"

typedef struct {
  uint32_t now;
  uint64_t epoch_base;
  bool clock_set;
  uint64_t free_bytes;
  uint8_t mode_seen;
  int mute_calls;
  bool recording;
  /* Captured frames from the device. */
  stick_parser_t parser;
  uint8_t resp[STICK_LINK_MAX_PAYLOAD];
  uint16_t resp_len;
  uint8_t resp_code;
  int responses;
  uint8_t events[32][4];
  int n_events;
} fake_t;

static fake_t fk;

static uint32_t f_uptime(void *ctx) { return ((fake_t *)ctx)->now; }
static uint64_t f_epoch(void *ctx) {
  fake_t *f = (fake_t *)ctx;
  return f->clock_set ? f->epoch_base + f->now : 0;
}
static void f_set_epoch(void *ctx, uint64_t ms) {
  fake_t *f = (fake_t *)ctx;
  f->epoch_base = ms - f->now;
  f->clock_set = true;
}
static void f_space(void *ctx, uint64_t *total, uint64_t *free_bytes) {
  *total = 32ull << 30;
  *free_bytes = ((fake_t *)ctx)->free_bytes;
}
static void f_mode(void *ctx, uint8_t mode) { ((fake_t *)ctx)->mode_seen = mode; }
static void f_mute(void *ctx, bool muted) {
  (void)muted;
  ((fake_t *)ctx)->mute_calls++;
}
static void f_recording(void *ctx, bool on) { ((fake_t *)ctx)->recording = on; }

static void on_frame(void *ctx, const stick_frame_t *f) {
  fake_t *k = (fake_t *)ctx;
  if (f->type == STICK_FRAME_RESPONSE) {
    memcpy(k->resp, f->payload, f->len);
    k->resp_len = f->len;
    k->resp_code = f->code;
    k->responses++;
  } else if (f->type == STICK_FRAME_EVENT && k->n_events < 32) {
    k->events[k->n_events][0] = f->code;
    memcpy(&k->events[k->n_events][1], f->payload, f->len < 3 ? f->len : 3);
    k->n_events++;
  }
}

static void f_send(void *ctx, const uint8_t *bytes, size_t len) { stick_parser_push(&((fake_t *)ctx)->parser, bytes, len, on_frame, ctx); }

static stick_device_t dev;
static stick_link_t link;
static uint8_t seq;

/* Sends one request and returns a reader over the response payload (status byte included). */
static stick_reader_t call(uint8_t code, const uint8_t *payload, size_t len) {
  uint8_t frame[64];
  size_t n = stick_frame_encode(frame, sizeof(frame), STICK_FRAME_REQUEST, code, ++seq, payload, len);
  int before = fk.responses;
  stick_device_rx(&dev, &link, frame, n);
  stick_reader_t r;
  stick_r_init(&r, fk.resp, fk.responses == before + 1 && fk.resp_code == code ? fk.resp_len : 0);
  return r;
}

static uint8_t call_status(uint8_t code, const uint8_t *payload, size_t len) {
  stick_reader_t r = call(code, payload, len);
  return r.len ? r.buf[0] : 0xff;
}

static int find_event(uint8_t code, uint8_t first) {
  for (int i = 0; i < fk.n_events; i++)
    if (fk.events[i][0] == code && fk.events[i][1] == first) return 1;
  return 0;
}

static void advance(uint32_t ms) {
  for (uint32_t i = 0; i < ms; i += 10) {
    fk.now += 10;
    stick_device_tick(&dev);
  }
}

static void feed_audio(synth_t *s, uint32_t ms) {
  int16_t pcm[160];
  for (uint32_t i = 0; i < ms; i += 10) {
    synth_fill(s, pcm, 160);
    if (fk.recording) stick_device_audio(&dev, pcm, 160);
    fk.now += 10;
    stick_device_tick(&dev);
  }
}

static void press(uint32_t ms) {
  for (uint32_t i = 0; i < ms; i += 5) fk.now += 5, stick_device_button(&dev, true);
  for (uint32_t i = 0; i < 400; i += 5) fk.now += 5, stick_device_button(&dev, false);
}

void test_device(void) {
  static stick_store_t store;
  const char *dir = test_dir("device");
  CHECK_EQ(stick_store_open(&store, dir, NULL), STICK_OK);
  memset(&fk, 0, sizeof(fk));
  fk.now = 5000;
  fk.free_bytes = 30ull << 30;
  const stick_platform_t p = {.ctx = &fk, .uptime_ms = f_uptime, .epoch_ms = f_epoch, .set_epoch_ms = f_set_epoch,
                              .space = f_space, .on_mode = f_mode, .on_mute = f_mute, .on_recording = f_recording};
  stick_identity_t id = {.hardware = 2, .caps = STICK_CAP_USB_MIC, .flash_kb = 16384, .serial = {0xbb, 1, 2, 3, 4, 5, 6, 7}};
  snprintf(id.firmware, sizeof(id.firmware), "1.2.3");
  stick_device_init(&dev, &p, &id, &store, STICK_MODE_MEETING_MIC, false);
  stick_device_attach(&dev, &link, f_send, &fk);
  stick_device_link_state(&dev, &link, true);
  stick_device_usb(&dev, true, false);

  stick_reader_t r = call(STICK_CMD_PING, NULL, 0);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u32(&r), 5000);

  r = call(STICK_CMD_INFO, NULL, 0);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u16(&r), 1);
  CHECK_EQ(stick_r_u16(&r), 2);
  CHECK(!memcmp(r.buf + r.pos, "1.2.3\0", 6));
  r.pos += 16;
  CHECK_EQ(stick_r_u8(&r), 0xbb);
  r.pos += 7;
  CHECK_EQ(stick_r_u32(&r), 16384);
  CHECK_EQ(stick_r_u32(&r), STICK_CAP_USB_MIC);
  CHECK(!r.error && r.pos == r.len);

  uint8_t t[8];
  stick_writer_t w;
  stick_w_init(&w, t, sizeof(t));
  stick_w_u64(&w, 1794470400000ull);
  CHECK_EQ(call_status(STICK_CMD_SET_TIME, t, 8), STICK_OK);
  CHECK(f_epoch(&fk) == 1794470400000ull);

  r = call(STICK_CMD_STATUS, NULL, 0);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u8(&r), STICK_STATE_IDLE);
  CHECK_EQ(stick_r_u8(&r), STICK_BATTERY_NONE);
  CHECK_EQ(stick_r_u8(&r), 0);
  CHECK_EQ(stick_r_u8(&r), STICK_MODE_MEETING_MIC);
  CHECK_EQ(stick_r_u32(&r), (uint32_t)((30ull << 30) / 1024));
  CHECK_EQ(stick_r_u32(&r), (uint32_t)((32ull << 30) / 1024));
  CHECK_EQ(stick_r_u16(&r), 0);
  stick_r_u16(&r);
  CHECK_EQ(stick_r_u32(&r), 0);
  CHECK_EQ(stick_r_u8(&r), STICK_FLAG_CLOCK_SET | STICK_FLAG_USB);
  CHECK(!r.error);

  /* Record two seconds from the app. */
  const uint8_t one = 1, zero = 0;
  r = call(STICK_CMD_RECORD, &one, 1);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u8(&r), STICK_STATE_RECORDING);
  CHECK_EQ(stick_r_u16(&r), 1);
  CHECK(fk.recording);
  CHECK(find_event(STICK_EVT_STATE, STICK_STATE_RECORDING));
  synth_t syn;
  synth_init(&syn, 3);
  feed_audio(&syn, 2000);
  r = call(STICK_CMD_STATUS, NULL, 0);
  CHECK_EQ(r.buf[1], STICK_STATE_RECORDING);
  r.pos = 17; /* status, state, battery, charging, mode, free, total, count, level */
  CHECK_EQ(stick_r_u32(&r), 2000);
  const uint8_t id1[2] = {1, 0};
  CHECK_EQ(call_status(STICK_CMD_DELETE, id1, 2), STICK_ERR_BUSY);
  r = call(STICK_CMD_RECORD, &zero, 1);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u8(&r), STICK_STATE_IDLE);
  CHECK_EQ(stick_r_u16(&r), 1);
  CHECK(!fk.recording);

  /* List and download it in chunks, as StickClient.read() does. */
  const uint8_t list_req[4] = {0, 0, 32, 0};
  r = call(STICK_CMD_LIST, list_req, 4);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u16(&r), 1);
  CHECK_EQ(stick_r_u8(&r), 1);
  CHECK_EQ(stick_r_u16(&r), 1);
  const uint32_t size = stick_r_u32(&r);
  const uint64_t start = stick_r_u64(&r);
  CHECK(start >= 1794470400000ull && start < 1794470400000ull + 1000);
  CHECK_EQ(stick_r_u32(&r), 2000);
  CHECK_EQ(stick_r_u8(&r), 0);
  uint8_t *wav = (uint8_t *)malloc(size);
  uint32_t off = 0;
  while (off < size) {
    uint8_t req[8];
    stick_w_init(&w, req, sizeof(req));
    stick_w_u16(&w, 1);
    stick_w_u32(&w, off);
    stick_w_u16(&w, 4080);
    r = call(STICK_CMD_READ, req, w.len);
    if (stick_r_u8(&r) != STICK_OK) break;
    CHECK_EQ(stick_r_u16(&r), 1);
    CHECK_EQ(stick_r_u32(&r), off);
    const size_t n = r.len - r.pos;
    memcpy(wav + off, r.buf + r.pos, n);
    off += (uint32_t)n;
  }
  CHECK_EQ(off, size);
  stick_wav_info_t info;
  CHECK(stick_wav_parse(wav, size, &info));
  CHECK_EQ(info.samples, 32000);
  CHECK_EQ(stick_device_state(&dev), STICK_STATE_SYNCING);
  advance(STICK_SYNC_LINGER_MS + 20);
  CHECK_EQ(stick_device_state(&dev), STICK_STATE_IDLE);
  free(wav);

  uint8_t bad_read[8];
  stick_w_init(&w, bad_read, sizeof(bad_read));
  stick_w_u16(&w, 1);
  stick_w_u32(&w, size);
  stick_w_u16(&w, 10);
  CHECK_EQ(call_status(STICK_CMD_READ, bad_read, 8), STICK_ERR_BAD_REQUEST);
  bad_read[0] = 9;
  CHECK_EQ(call_status(STICK_CMD_READ, bad_read, 8), STICK_ERR_NOT_FOUND);
  CHECK_EQ(call_status(STICK_CMD_READ, bad_read, 2), STICK_ERR_BAD_REQUEST);
  CHECK_EQ(call_status(STICK_CMD_MARK_SYNCED, id1, 2), STICK_OK);
  r = call(STICK_CMD_LIST, list_req, 4);
  CHECK_EQ(r.buf[4 + 18], 1); /* synced flag */

  /* Modes, lights, unknown commands. */
  const uint8_t room = STICK_MODE_ROOM, seven = 7, rainbow = 1, nine = 9;
  r = call(STICK_CMD_SET_MODE, &room, 1);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u8(&r), STICK_MODE_ROOM);
  CHECK_EQ(fk.mode_seen, STICK_MODE_ROOM);
  CHECK_EQ(call_status(STICK_CMD_SET_MODE, &seven, 1), STICK_ERR_BAD_REQUEST);
  CHECK_EQ(call_status(STICK_CMD_LED_TEST, &rainbow, 1), STICK_OK);
  CHECK_EQ(call_status(STICK_CMD_LED_TEST, &nine, 1), STICK_ERR_BAD_REQUEST);
  CHECK_EQ(call_status(0x55, NULL, 0), STICK_ERR_UNSUPPORTED);

  /* Button: long press records, double press changes mode, short press mutes while streaming. */
  fk.n_events = 0;
  press(1400);
  CHECK(stick_device_recording(&dev));
  CHECK(find_event(STICK_EVT_BUTTON, STICK_GESTURE_LONG));
  feed_audio(&syn, 1000);
  press(1400);
  CHECK(!stick_device_recording(&dev));
  CHECK_EQ(store.count, 2);
  for (int i = 0; i < 2; i++) {
    for (int k = 0; k < 20; k++) fk.now += 5, stick_device_button(&dev, true);
    for (int k = 0; k < 20; k++) fk.now += 5, stick_device_button(&dev, false);
  }
  advance(400);
  CHECK(find_event(STICK_EVT_BUTTON, STICK_GESTURE_DOUBLE));
  CHECK_EQ(dev.mode, STICK_MODE_MEETING_MIC); /* room -> meeting mic */
  stick_device_usb(&dev, true, true);
  CHECK_EQ(stick_device_state(&dev), STICK_STATE_STREAMING);
  press(100);
  CHECK(dev.muted);
  CHECK(find_event(STICK_EVT_BUTTON, STICK_GESTURE_SHORT));
  r = call(STICK_CMD_STATUS, NULL, 0);
  CHECK(r.buf[r.len - 1] & STICK_FLAG_MUTED);
  stick_device_usb(&dev, true, false); /* call ends: mute resets */
  CHECK(!dev.muted);
  CHECK_EQ(fk.mute_calls, 2);

  /* Battery: low battery refuses to record and stops a recording in progress, saving it. */
  stick_device_usb(&dev, false, false);
  stick_device_battery(&dev, 40, false);
  CHECK(find_event(STICK_EVT_BATTERY, 40));
  CHECK_EQ(call_status(STICK_CMD_RECORD, &one, 1), STICK_OK);
  feed_audio(&syn, 500);
  fk.now += 6000;
  stick_device_battery(&dev, 4, false);
  CHECK_EQ(stick_device_state(&dev), STICK_STATE_LOW_BATTERY);
  stick_device_tick(&dev);
  CHECK(!stick_device_recording(&dev));
  CHECK_EQ(store.count, 3);
  CHECK(find_event(STICK_EVT_STATE, STICK_STATE_LOW_BATTERY));
  CHECK_EQ(call_status(STICK_CMD_RECORD, &one, 1), STICK_ERR_BUSY);
  stick_device_battery(&dev, 4, true);
  CHECK_EQ(stick_device_state(&dev), STICK_STATE_IDLE);

  /* A full card refuses to start; idle detection for sleep. */
  fk.free_bytes = 512 * 1024;
  CHECK_EQ(call_status(STICK_CMD_RECORD, &one, 1), STICK_ERR_IO);
  fk.free_bytes = 30ull << 30;
  CHECK(!stick_device_idle_for(&dev, 60000));
  advance(61000);
  CHECK(stick_device_idle_for(&dev, 60000));
  stick_store_close(&store);

  /* No card: still a microphone; storage commands report it. */
  stick_device_init(&dev, &p, &id, NULL, STICK_MODE_MEETING_MIC, false);
  stick_device_attach(&dev, &link, f_send, &fk);
  CHECK_EQ(call_status(STICK_CMD_RECORD, &one, 1), STICK_ERR_IO);
  r = call(STICK_CMD_LIST, list_req, 4);
  CHECK_EQ(stick_r_u8(&r), STICK_OK);
  CHECK_EQ(stick_r_u16(&r), 0);
  r = call(STICK_CMD_STATUS, NULL, 0);
  CHECK(r.buf[r.len - 1] & STICK_FLAG_NO_STORAGE);
}
