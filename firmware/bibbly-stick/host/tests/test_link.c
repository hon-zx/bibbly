#include "stick_link.h"
#include "test.h"

typedef struct {
  int n;
  uint8_t code[8];
  uint8_t seq[8];
  uint16_t len[8];
} seen_t;

static void collect(void *ctx, const stick_frame_t *f) {
  seen_t *s = (seen_t *)ctx;
  if (s->n < 8) {
    s->code[s->n] = f->code;
    s->seq[s->n] = f->seq;
    s->len[s->n] = f->len;
  }
  s->n++;
}

void test_link(void) {
  CHECK_EQ(stick_crc32((const uint8_t *)"123456789", 9), 0xcbf43926u);

  /* Same stream as the TypeScript FrameParser test: garbage, a ping, a corrupt event, a stray magic byte, an event. */
  uint8_t a[16], b[16], corrupt[16], stream[64];
  const uint8_t three = 3, one = 1;
  size_t na = stick_frame_encode(a, sizeof(a), STICK_FRAME_REQUEST, STICK_CMD_PING, 7, NULL, 0);
  size_t nb = stick_frame_encode(b, sizeof(b), STICK_FRAME_EVENT, STICK_EVT_BUTTON, 0, &three, 1);
  size_t nc = stick_frame_encode(corrupt, sizeof(corrupt), STICK_FRAME_EVENT, STICK_EVT_BUTTON, 1, &one, 1);
  CHECK_EQ(na, 12);
  CHECK_EQ(nb, 13);
  corrupt[nc - 1] ^= 0xff;
  size_t n = 0;
  stream[n++] = 0x00;
  stream[n++] = 0x42;
  stream[n++] = 0x13;
  memcpy(stream + n, a, na), n += na;
  memcpy(stream + n, corrupt, nc), n += nc;
  stream[n++] = 0x42;
  memcpy(stream + n, b, nb), n += nb;
  static stick_parser_t p;
  stick_parser_reset(&p);
  seen_t seen = {0};
  for (size_t i = 0; i < n; i += 5) stick_parser_push(&p, stream + i, n - i < 5 ? n - i : 5, collect, &seen);
  CHECK_EQ(seen.n, 2);
  CHECK_EQ(seen.code[0], STICK_CMD_PING);
  CHECK_EQ(seen.seq[0], 7);
  CHECK_EQ(seen.code[1], STICK_EVT_BUTTON);
  CHECK(p.dropped > 0);

  /* Largest payload round-trips; one byte more is refused. */
  static uint8_t big[STICK_LINK_MAX_FRAME + 1], payload[STICK_LINK_MAX_PAYLOAD + 1];
  for (size_t i = 0; i < sizeof(payload); i++) payload[i] = (uint8_t)(i * 7);
  CHECK_EQ(stick_frame_encode(big, sizeof(big), STICK_FRAME_RESPONSE, STICK_CMD_READ, 9, payload, STICK_LINK_MAX_PAYLOAD),
           STICK_LINK_MAX_FRAME);
  CHECK_EQ(stick_frame_encode(big, sizeof(big), STICK_FRAME_RESPONSE, STICK_CMD_READ, 9, payload, STICK_LINK_MAX_PAYLOAD + 1),
           0);
  seen_t one_big = {0};
  stick_parser_reset(&p);
  stick_parser_push(&p, big, STICK_LINK_MAX_FRAME, collect, &one_big);
  CHECK_EQ(one_big.n, 1);
  CHECK_EQ(one_big.len[0], STICK_LINK_MAX_PAYLOAD);

  /* A frame from a future protocol version is skipped. */
  uint8_t v2[16];
  size_t n2 = stick_frame_encode(v2, sizeof(v2), STICK_FRAME_REQUEST, STICK_CMD_PING, 1, NULL, 0);
  v2[2] = 2;
  seen_t none = {0};
  stick_parser_reset(&p);
  stick_parser_push(&p, v2, n2, collect, &none);
  CHECK_EQ(none.n, 0);

  /* Writer and reader. */
  uint8_t wb[8];
  stick_writer_t w;
  stick_w_init(&w, wb, sizeof(wb));
  stick_w_u16(&w, 0xbeef);
  stick_w_u32(&w, 0x01020304);
  CHECK(!w.overflow);
  stick_w_u32(&w, 5);
  CHECK(w.overflow);
  CHECK_EQ(wb[0], 0xef);
  CHECK_EQ(wb[2], 0x04);
  stick_reader_t r;
  stick_r_init(&r, wb, 6);
  CHECK_EQ(stick_r_u16(&r), 0xbeef);
  CHECK_EQ(stick_r_u32(&r), 0x01020304);
  CHECK(!r.error);
  CHECK_EQ(stick_r_u8(&r), 0);
  CHECK(r.error);
  uint8_t sb[4];
  stick_w_init(&w, sb, sizeof(sb));
  stick_w_str(&w, "ab", 4);
  CHECK(sb[0] == 'a' && sb[1] == 'b' && sb[2] == 0 && sb[3] == 0);
  uint8_t u64[8];
  stick_w_init(&w, u64, sizeof(u64));
  stick_w_u64(&w, 1794470400000ull);
  stick_r_init(&r, u64, 8);
  CHECK(stick_r_u64(&r) == 1794470400000ull);
}
