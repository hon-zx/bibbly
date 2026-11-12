#include "stick_link.h"

#include <string.h>

static uint32_t crc_table[256];
static bool crc_ready;

static void crc_init(void) {
  for (uint32_t n = 0; n < 256; n++) {
    uint32_t c = n;
    for (int k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320u ^ (c >> 1) : c >> 1;
    crc_table[n] = c;
  }
  crc_ready = true;
}

uint32_t stick_crc32_update(uint32_t crc, const uint8_t *data, size_t len) {
  if (!crc_ready) crc_init();
  crc = ~crc;
  for (size_t i = 0; i < len; i++) crc = crc_table[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  return ~crc;
}

uint32_t stick_crc32(const uint8_t *data, size_t len) { return stick_crc32_update(0, data, len); }

static void put16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}

static void put32(uint8_t *p, uint32_t v) {
  put16(p, (uint16_t)v);
  put16(p + 2, (uint16_t)(v >> 16));
}

static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

static uint32_t get32(const uint8_t *p) { return (uint32_t)get16(p) | ((uint32_t)get16(p + 2) << 16); }

size_t stick_frame_encode(uint8_t *out, size_t cap, uint8_t type, uint8_t code, uint8_t seq, const uint8_t *payload,
                          size_t len) {
  if (len > STICK_LINK_MAX_PAYLOAD || cap < STICK_LINK_OVERHEAD + len) return 0;
  out[0] = 0x42;
  out[1] = 0x42;
  out[2] = STICK_LINK_VERSION;
  out[3] = type;
  out[4] = code;
  out[5] = seq;
  put16(out + 6, (uint16_t)len);
  if (len && payload != out + STICK_LINK_HEADER) memmove(out + STICK_LINK_HEADER, payload, len);
  put32(out + STICK_LINK_HEADER + len, stick_crc32(out + 2, STICK_LINK_HEADER - 2 + len));
  return STICK_LINK_OVERHEAD + len;
}

void stick_parser_reset(stick_parser_t *p) {
  p->fill = 0;
  p->dropped = 0;
}

static void drop(stick_parser_t *p, size_t n) {
  if (n >= p->fill) {
    p->fill = 0;
    return;
  }
  memmove(p->buf, p->buf + n, p->fill - n);
  p->fill -= n;
}

/* Extracts every complete frame currently in the buffer. */
static void parse(stick_parser_t *p, stick_frame_cb cb, void *ctx) {
  for (;;) {
    size_t i = 0;
    while (i + 1 < p->fill && !(p->buf[i] == 0x42 && p->buf[i + 1] == 0x42)) i++;
    if (i + 1 >= p->fill && p->fill && p->buf[p->fill - 1] != 0x42) i = p->fill; /* no magic start at all */
    if (i > 0) {
      p->dropped += (uint32_t)i;
      drop(p, i);
    }
    if (p->fill < STICK_LINK_HEADER) return;
    const uint16_t len = get16(p->buf + 6);
    if (p->buf[2] != STICK_LINK_VERSION || len > STICK_LINK_MAX_PAYLOAD) {
      p->dropped++;
      drop(p, 1);
      continue;
    }
    if (p->fill < (size_t)STICK_LINK_OVERHEAD + len) return;
    const uint32_t crc = get32(p->buf + STICK_LINK_HEADER + len);
    if (crc != stick_crc32(p->buf + 2, STICK_LINK_HEADER - 2 + (size_t)len)) {
      p->dropped++;
      drop(p, 1);
      continue;
    }
    const stick_frame_t f = {
        .type = p->buf[3], .code = p->buf[4], .seq = p->buf[5], .len = len, .payload = p->buf + STICK_LINK_HEADER};
    cb(ctx, &f);
    drop(p, (size_t)STICK_LINK_OVERHEAD + len);
  }
}

void stick_parser_push(stick_parser_t *p, const uint8_t *data, size_t len, stick_frame_cb cb, void *ctx) {
  while (len) {
    size_t room = sizeof(p->buf) - p->fill;
    size_t n = len < room ? len : room;
    memcpy(p->buf + p->fill, data, n);
    p->fill += n;
    data += n;
    len -= n;
    parse(p, cb, ctx);
  }
}

void stick_w_init(stick_writer_t *w, uint8_t *buf, size_t cap) {
  w->buf = buf;
  w->cap = cap;
  w->len = 0;
  w->overflow = false;
}

void stick_w_bytes(stick_writer_t *w, const void *data, size_t n) {
  if (w->len + n > w->cap) {
    w->overflow = true;
    return;
  }
  if (n) memcpy(w->buf + w->len, data, n);
  w->len += n;
}

void stick_w_u8(stick_writer_t *w, uint8_t v) { stick_w_bytes(w, &v, 1); }

void stick_w_u16(stick_writer_t *w, uint16_t v) {
  uint8_t b[2];
  put16(b, v);
  stick_w_bytes(w, b, 2);
}

void stick_w_u32(stick_writer_t *w, uint32_t v) {
  uint8_t b[4];
  put32(b, v);
  stick_w_bytes(w, b, 4);
}

void stick_w_u64(stick_writer_t *w, uint64_t v) {
  stick_w_u32(w, (uint32_t)v);
  stick_w_u32(w, (uint32_t)(v >> 32));
}

void stick_w_str(stick_writer_t *w, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    uint8_t c = 0;
    if (s && *s) c = (uint8_t)*s++;
    stick_w_u8(w, c);
  }
}

void stick_r_init(stick_reader_t *r, const uint8_t *buf, size_t len) {
  r->buf = buf;
  r->len = len;
  r->pos = 0;
  r->error = false;
}

static bool need(stick_reader_t *r, size_t n) {
  if (r->error || r->pos + n > r->len) {
    r->error = true;
    return false;
  }
  return true;
}

uint8_t stick_r_u8(stick_reader_t *r) { return need(r, 1) ? r->buf[r->pos++] : 0; }

uint16_t stick_r_u16(stick_reader_t *r) {
  if (!need(r, 2)) return 0;
  uint16_t v = get16(r->buf + r->pos);
  r->pos += 2;
  return v;
}

uint32_t stick_r_u32(stick_reader_t *r) {
  if (!need(r, 4)) return 0;
  uint32_t v = get32(r->buf + r->pos);
  r->pos += 4;
  return v;
}

uint64_t stick_r_u64(stick_reader_t *r) {
  uint64_t lo = stick_r_u32(r);
  uint64_t hi = stick_r_u32(r);
  return lo | (hi << 32);
}
