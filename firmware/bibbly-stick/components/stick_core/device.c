#include "stick_device.h"

#include <string.h>

static uint32_t now(const stick_device_t *d) { return d->p.uptime_ms(d->p.ctx); }

static bool after(uint32_t a, uint32_t b) { return (int32_t)(a - b) > 0; }

static bool low_battery(const stick_device_t *d) {
  return d->battery != STICK_BATTERY_NONE && !d->charging && d->battery <= STICK_LOW_BATTERY_PCT;
}

static uint8_t major_state(const stick_device_t *d) {
  if (d->fault) return STICK_STATE_ERROR;
  if (low_battery(d)) return STICK_STATE_LOW_BATTERY;
  if (d->rec.active) return STICK_STATE_RECORDING;
  if (d->streaming) return STICK_STATE_STREAMING;
  return STICK_STATE_IDLE;
}

uint8_t stick_device_state(const stick_device_t *d) {
  uint8_t s = major_state(d);
  if ((s == STICK_STATE_IDLE || s == STICK_STATE_STREAMING) && after(d->sync_until, now(d))) return STICK_STATE_SYNCING;
  return s;
}

bool stick_device_recording(const stick_device_t *d) { return d->rec.active; }

static void emit(stick_device_t *d, uint8_t code, const uint8_t *payload, size_t len) {
  uint8_t frame[STICK_LINK_OVERHEAD + 16];
  size_t n = stick_frame_encode(frame, sizeof(frame), STICK_FRAME_EVENT, code, d->evt_seq++, payload, len);
  for (size_t i = 0; i < d->n_links && n; i++) {
    stick_link_t *l = d->links[i];
    if (l->connected) l->send(l->ctx, frame, n);
  }
  if (d->p.on_event) d->p.on_event(d->p.ctx, code, payload, len);
}

static void update_state(stick_device_t *d) {
  const uint8_t s = major_state(d);
  if (s == d->state) return;
  d->state = s;
  const uint16_t id = d->rec.active ? d->rec.id : 0;
  const uint8_t payload[3] = {s, (uint8_t)id, (uint8_t)(id >> 8)};
  emit(d, STICK_EVT_STATE, payload, sizeof(payload));
}

static void flash(stick_device_t *d, uint8_t kind, uint8_t arg) { stick_lights_flash(&d->lights, kind, arg, now(d)); }

static void space(const stick_device_t *d, uint64_t *total, uint64_t *free_bytes) {
  *total = *free_bytes = 0;
  if (d->store && d->p.space) d->p.space(d->p.ctx, total, free_bytes);
}

void stick_device_init(stick_device_t *d, const stick_platform_t *p, const stick_identity_t *id, stick_store_t *store,
                       uint8_t mode, bool button_held) {
  memset(d, 0, sizeof(*d));
  d->p = *p;
  d->id = *id;
  d->store = store;
  d->mode = mode < STICK_MODE_COUNT ? mode : STICK_MODE_MEETING_MIC;
  d->battery = d->evt_battery = STICK_BATTERY_NONE;
  d->state = STICK_STATE_IDLE;
  d->level_db10 = -1000;
  const uint32_t t = now(d);
  d->last_activity = t;
  d->sync_until = t;
  stick_button_init(&d->button, button_held, t);
}

void stick_device_attach(stick_device_t *d, stick_link_t *l, void (*send)(void *ctx, const uint8_t *bytes, size_t len),
                         void *ctx) {
  l->send = send;
  l->ctx = ctx;
  l->connected = false;
  l->dev = d;
  stick_parser_reset(&l->parser);
  if (d->n_links < STICK_MAX_LINKS) d->links[d->n_links++] = l;
}

void stick_device_link_state(stick_device_t *d, stick_link_t *l, bool connected) {
  (void)d;
  if (l->connected != connected) stick_parser_reset(&l->parser);
  l->connected = connected;
}

int stick_device_set_mode(stick_device_t *d, uint8_t mode) {
  if (mode >= STICK_MODE_COUNT) return STICK_ERR_BAD_REQUEST;
  flash(d, STICK_FLASH_MODE, mode);
  if (mode != d->mode) {
    d->mode = mode;
    if (d->p.on_mode) d->p.on_mode(d->p.ctx, mode);
  }
  return STICK_OK;
}

int stick_device_record(stick_device_t *d, bool start, uint16_t *id_out) {
  uint16_t id = 0;
  int rc = STICK_OK;
  if (start) {
    uint64_t total, free_bytes;
    space(d, &total, &free_bytes);
    if (d->rec.active) id = d->rec.id;
    else if (!d->store) rc = STICK_ERR_IO;
    else if (low_battery(d)) rc = STICK_ERR_BUSY;
    else if (d->p.space && free_bytes < STICK_MIN_FREE_TO_RECORD) rc = STICK_ERR_IO;
    else {
      const uint64_t epoch = d->p.epoch_ms ? d->p.epoch_ms(d->p.ctx) : 0;
      rc = stick_recorder_start(&d->rec, d->store, epoch, &id);
      if (rc == STICK_OK) {
        d->flushed_at = now(d);
        flash(d, STICK_FLASH_REC_START, 0);
        if (d->p.on_recording) d->p.on_recording(d->p.ctx, true);
      }
    }
    if (rc != STICK_OK) flash(d, STICK_FLASH_ERROR, 0);
  } else if (d->rec.active) {
    if (d->p.on_recording) d->p.on_recording(d->p.ctx, false);
    rc = stick_recorder_stop(&d->rec, &id);
    flash(d, rc == STICK_OK ? STICK_FLASH_REC_STOP : STICK_FLASH_ERROR, 0);
  }
  d->last_activity = now(d);
  update_state(d);
  if (id_out) *id_out = id;
  return rc;
}

void stick_device_gesture(stick_device_t *d, uint8_t gesture) {
  if (gesture == STICK_GESTURE_NONE) return;
  d->last_activity = now(d);
  switch (gesture) {
    case STICK_GESTURE_LONG:
      stick_device_record(d, !d->rec.active, NULL);
      break;
    case STICK_GESTURE_DOUBLE:
      stick_device_set_mode(d, (uint8_t)((d->mode + 1) % STICK_MODE_COUNT));
      break;
    case STICK_GESTURE_SHORT:
      if (d->streaming) {
        d->muted = !d->muted;
        if (d->p.on_mute) d->p.on_mute(d->p.ctx, d->muted);
        flash(d, STICK_FLASH_ACK, 0);
      } else {
        flash(d, STICK_FLASH_BATTERY, 0);
      }
      break;
    default:
      return;
  }
  emit(d, STICK_EVT_BUTTON, &gesture, 1);
}

void stick_device_button(stick_device_t *d, bool pressed) {
  stick_device_gesture(d, stick_button_update(&d->button, pressed, now(d)));
}

/* Card removed or failing: keep what was written and tell the user. */
static void record_failed(stick_device_t *d) {
  if (d->p.on_recording) d->p.on_recording(d->p.ctx, false);
  stick_recorder_abort(&d->rec);
  flash(d, STICK_FLASH_ERROR, 0);
  update_state(d);
}

void stick_device_audio(stick_device_t *d, const int16_t *pcm, size_t n) {
  if (!d->rec.active || !n) return;
  if (stick_recorder_write(&d->rec, pcm, n) != STICK_OK) record_failed(d);
}

void stick_device_level(stick_device_t *d, int16_t level_db10) { d->level_db10 = level_db10; }

void stick_device_usb(stick_device_t *d, bool connected, bool streaming) {
  const bool was_streaming = d->streaming;
  d->usb = connected;
  d->streaming = connected && streaming;
  if (was_streaming && !d->streaming && d->muted) {
    d->muted = false; /* mute is per call, like a conference phone */
    if (d->p.on_mute) d->p.on_mute(d->p.ctx, false);
  }
  if (connected) d->last_activity = now(d);
  update_state(d);
}

void stick_device_battery(stick_device_t *d, uint8_t pct, bool charging) {
  if (pct > 100 && pct != STICK_BATTERY_NONE) pct = 100;
  d->battery = pct;
  d->charging = charging;
  const uint32_t t = now(d);
  if (charging != d->evt_charging || (pct != d->evt_battery && (uint32_t)(t - d->evt_battery_at) >= 5000)) {
    d->evt_battery = pct;
    d->evt_charging = charging;
    d->evt_battery_at = t;
    const uint8_t payload[2] = {pct, charging ? 1 : 0};
    emit(d, STICK_EVT_BATTERY, payload, sizeof(payload));
  }
  update_state(d);
}

void stick_device_fault(stick_device_t *d, bool fault) {
  d->fault = fault;
  update_state(d);
}

void stick_device_tick(stick_device_t *d) {
  const uint32_t t = now(d);
  if (d->rec.active) {
    if (low_battery(d)) {
      stick_device_record(d, false, NULL); /* save before the battery gives out */
    } else if ((uint32_t)(t - d->flushed_at) >= STICK_FLUSH_EVERY_MS) {
      d->flushed_at = t;
      uint64_t total, free_bytes;
      space(d, &total, &free_bytes);
      if (stick_recorder_flush(&d->rec) != STICK_OK) {
        record_failed(d);
      } else if (d->p.space && free_bytes < STICK_MIN_FREE_RECORDING) {
        stick_device_record(d, false, NULL);
        flash(d, STICK_FLASH_ERROR, 0); /* card full */
      }
    }
  }
  update_state(d);
}

bool stick_device_idle_for(const stick_device_t *d, uint32_t ms) {
  return !d->usb && !d->rec.active && (uint32_t)(now(d) - d->last_activity) >= ms;
}

void stick_device_render(stick_device_t *d, stick_rgb_t eyes[STICK_EYES], stick_rgb_t *ring, size_t ring_n) {
  stick_lights_t *l = &d->lights;
  l->state = stick_device_state(d);
  l->mode = d->mode;
  l->battery = d->battery;
  l->charging = d->charging;
  l->usb = d->usb;
  l->muted = d->muted;
  stick_lights_render(l, now(d), eyes, ring, ring_n);
}

/* ---- Link commands ----------------------------------------------------------- */

static void status_only(stick_writer_t *w, uint8_t status) {
  w->len = 0;
  w->overflow = false;
  stick_w_u8(w, status);
}

static void cmd_status(stick_device_t *d, stick_writer_t *w) {
  uint64_t total, free_bytes;
  space(d, &total, &free_bytes);
  if (d->store && !d->p.space) total = free_bytes = 0;
  uint8_t flags = 0;
  if (d->muted) flags |= STICK_FLAG_MUTED;
  if (d->p.epoch_ms && d->p.epoch_ms(d->p.ctx)) flags |= STICK_FLAG_CLOCK_SET;
  if (d->store && stick_store_encrypted(d->store)) flags |= STICK_FLAG_ENCRYPTED;
  if (d->usb) flags |= STICK_FLAG_USB;
  if (!d->store) flags |= STICK_FLAG_NO_STORAGE;
  stick_w_u8(w, STICK_OK);
  stick_w_u8(w, stick_device_state(d));
  stick_w_u8(w, d->battery);
  stick_w_u8(w, d->charging ? 1 : 0);
  stick_w_u8(w, d->mode);
  stick_w_u32(w, (uint32_t)(free_bytes / 1024));
  stick_w_u32(w, (uint32_t)(total / 1024));
  stick_w_u16(w, d->store ? d->store->count : 0);
  stick_w_u16(w, (uint16_t)d->level_db10);
  stick_w_u32(w, stick_recorder_ms(&d->rec));
  stick_w_u8(w, flags);
}

static void cmd_list(stick_device_t *d, stick_reader_t *r, stick_writer_t *w) {
  const uint16_t start = stick_r_u16(r);
  uint16_t max = stick_r_u16(r);
  if (r->error) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
  const uint16_t total = d->store ? d->store->count : 0;
  const uint16_t fit = (STICK_LINK_MAX_PAYLOAD - 4) / STICK_LIST_ENTRY;
  if (max > fit) max = fit;
  if (max > 255) max = 255;
  uint16_t count = start < total ? (uint16_t)(total - start) : 0;
  if (count > max) count = max;
  stick_w_u8(w, STICK_OK);
  stick_w_u16(w, total);
  stick_w_u8(w, (uint8_t)count);
  for (uint16_t i = 0; i < count; i++) {
    const stick_rec_t *rec = &d->store->recs[start + i];
    stick_w_u16(w, rec->id);
    stick_w_u32(w, rec->size);
    stick_w_u64(w, rec->start_epoch_ms);
    stick_w_u32(w, rec->duration_ms);
    stick_w_u8(w, rec->flags & STICK_REC_SYNCED ? 1 : 0);
    stick_w_u8(w, 0);
  }
}

static void cmd_read(stick_device_t *d, stick_reader_t *r, stick_writer_t *w) {
  const uint16_t id = stick_r_u16(r);
  const uint32_t offset = stick_r_u32(r);
  uint32_t len = stick_r_u16(r);
  if (r->error || len == 0) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
  if (!d->store) { status_only(w, STICK_ERR_IO); return; }
  if (len > STICK_LINK_MAX_PAYLOAD - STICK_READ_OVERHEAD) len = STICK_LINK_MAX_PAYLOAD - STICK_READ_OVERHEAD;
  stick_w_u8(w, STICK_OK);
  stick_w_u16(w, id);
  stick_w_u32(w, offset);
  uint32_t got = 0;
  const int rc = stick_store_read(d->store, id, offset, w->buf + w->len, len, &got);
  if (rc != STICK_OK) { status_only(w, (uint8_t)rc); return; }
  w->len += got;
  d->sync_until = now(d) + STICK_SYNC_LINGER_MS;
}

static void cmd_id(stick_device_t *d, uint8_t code, stick_reader_t *r, stick_writer_t *w) {
  const uint16_t id = stick_r_u16(r);
  if (r->error) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
  if (!d->store) { status_only(w, STICK_ERR_IO); return; }
  const int rc = code == STICK_CMD_DELETE ? stick_store_delete(d->store, id) : stick_store_mark_synced(d->store, id);
  status_only(w, (uint8_t)rc);
}

static void handle(stick_device_t *d, uint8_t code, stick_reader_t *r, stick_writer_t *w) {
  switch (code) {
    case STICK_CMD_PING:
      stick_w_u8(w, STICK_OK);
      stick_w_u32(w, now(d));
      break;
    case STICK_CMD_INFO: {
      uint32_t caps = d->id.caps;
      if (d->store && stick_store_encrypted(d->store)) caps |= STICK_CAP_ENCRYPTED;
      stick_w_u8(w, STICK_OK);
      stick_w_u16(w, STICK_LINK_VERSION);
      stick_w_u16(w, d->id.hardware);
      stick_w_str(w, d->id.firmware, 16);
      stick_w_bytes(w, d->id.serial, 8);
      stick_w_u32(w, d->id.flash_kb);
      stick_w_u32(w, caps);
      break;
    }
    case STICK_CMD_STATUS:
      cmd_status(d, w);
      break;
    case STICK_CMD_LIST:
      cmd_list(d, r, w);
      break;
    case STICK_CMD_READ:
      cmd_read(d, r, w);
      break;
    case STICK_CMD_DELETE:
    case STICK_CMD_MARK_SYNCED:
      cmd_id(d, code, r, w);
      break;
    case STICK_CMD_SET_TIME: {
      const uint64_t epoch = stick_r_u64(r);
      if (r->error || epoch == 0) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
      if (d->p.set_epoch_ms) d->p.set_epoch_ms(d->p.ctx, epoch);
      stick_w_u8(w, STICK_OK);
      break;
    }
    case STICK_CMD_SET_MODE: {
      const uint8_t mode = stick_r_u8(r);
      if (r->error) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
      const int rc = stick_device_set_mode(d, mode);
      if (rc != STICK_OK) { status_only(w, (uint8_t)rc); return; }
      stick_w_u8(w, STICK_OK);
      stick_w_u8(w, d->mode);
      break;
    }
    case STICK_CMD_RECORD: {
      const uint8_t start = stick_r_u8(r);
      if (r->error || start > 1) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
      uint16_t id = 0;
      const int rc = stick_device_record(d, start == 1, &id);
      if (rc != STICK_OK) { status_only(w, (uint8_t)rc); return; }
      stick_w_u8(w, STICK_OK);
      stick_w_u8(w, major_state(d)); /* the recording state, not the brief "syncing" light after a download */
      stick_w_u16(w, id);
      break;
    }
    case STICK_CMD_LED_TEST: {
      const uint8_t pattern = stick_r_u8(r);
      if (r->error || pattern > 3) { status_only(w, STICK_ERR_BAD_REQUEST); return; }
      d->lights.test = pattern;
      d->lights.test_at = now(d);
      stick_w_u8(w, STICK_OK);
      break;
    }
    default:
      status_only(w, STICK_ERR_UNSUPPORTED);
      break;
  }
}

static void on_frame(void *ctx, const stick_frame_t *f) {
  stick_link_t *l = (stick_link_t *)ctx;
  stick_device_t *d = l->dev;
  if (f->type != STICK_FRAME_REQUEST) return;
  d->last_activity = now(d);
  stick_writer_t w;
  stick_w_init(&w, d->out + STICK_LINK_HEADER, STICK_LINK_MAX_PAYLOAD);
  stick_reader_t r;
  stick_r_init(&r, f->payload, f->len);
  handle(d, f->code, &r, &w);
  if (w.overflow) status_only(&w, STICK_ERR_IO);
  const size_t n = stick_frame_encode(d->out, sizeof(d->out), STICK_FRAME_RESPONSE, f->code, f->seq,
                                      d->out + STICK_LINK_HEADER, w.len);
  if (n) l->send(l->ctx, d->out, n);
}

void stick_device_rx(stick_device_t *d, stick_link_t *l, const uint8_t *bytes, size_t len) {
  (void)d;
  l->connected = true;
  stick_parser_push(&l->parser, bytes, len, on_frame, l);
}
