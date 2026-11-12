#include <stdlib.h>

#include "stick_link.h"
#include "stick_store.h"
#include "synth.h"
#include "test.h"

static const uint8_t KEY_A[STICK_KEY_LEN] = "key-a-for-bibbly-stick-tests-01";
static const uint8_t KEY_B[STICK_KEY_LEN] = "key-b-for-bibbly-stick-tests-02";

static void counter_random(void *ctx, uint8_t *out, size_t len) {
  uint32_t *c = (uint32_t *)ctx;
  for (size_t i = 0; i < len; i++) out[i] = (uint8_t)((*c)++ * 37u + 11u);
}

static void hex(const char *s, uint8_t *out) {
  for (size_t i = 0; s[2 * i]; i++) {
    unsigned v;
    sscanf(s + 2 * i, "%2x", &v);
    out[i] = (uint8_t)v;
  }
}

/* Records `seconds` of synthesised talk; returns the id. */
static uint16_t record(stick_store_t *s, double seconds, uint64_t epoch) {
  static stick_recorder_t rec;
  synth_t syn;
  synth_init(&syn, 42);
  uint16_t id = 0;
  CHECK_EQ(stick_recorder_start(&rec, s, epoch, NULL), STICK_OK);
  int16_t pcm[500];
  for (long left = (long)(seconds * 16000); left > 0; left -= 500) {
    size_t n = left < 500 ? (size_t)left : 500;
    synth_fill(&syn, pcm, n);
    CHECK_EQ(stick_recorder_write(&rec, pcm, n), STICK_OK);
  }
  CHECK_EQ(stick_recorder_stop(&rec, &id), STICK_OK);
  return id;
}

/* Reads a whole recording through the store in link-sized chunks. */
static uint8_t *read_all(stick_store_t *s, uint16_t id, uint32_t *size) {
  const stick_rec_t *r = stick_store_get(s, id);
  if (!r) return NULL;
  uint8_t *buf = (uint8_t *)malloc(r->size);
  uint32_t off = 0;
  while (off < r->size) {
    uint32_t got = 0;
    if (stick_store_read(s, id, off, buf + off, 4089, &got) != STICK_OK || got == 0) break;
    off += got;
  }
  *size = off;
  return buf;
}

static long file_size(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return -1;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fclose(f);
  return n;
}

static void test_aes_vectors(void) {
  /* NIST SP 800-38A F.5.5, CTR-AES256.Encrypt, with the counter split as our nonce + block index. */
  stick_cipher_t c;
  uint32_t ctr = 0;
  uint8_t key[32], nonce[12], data[32], expect[32];
  hex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4", key);
  hex("f0f1f2f3f4f5f6f7f8f9fafb", nonce);
  hex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51", data);
  hex("601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c5", expect);
  CHECK(stick_cipher_aes_init(&c, key, counter_random, &ctr));
  const uint64_t base = 0xfcfdfeffull * 16;
  uint8_t whole[32];
  memcpy(whole, data, 32);
  c.xcrypt(&c, nonce, base, whole, 32);
  CHECK(!memcmp(whole, expect, 32));
  /* Random access: decrypting bytes 5..25 alone gives the same bytes. */
  uint8_t part[20];
  memcpy(part, data + 5, 20);
  c.xcrypt(&c, nonce, base + 5, part, 20);
  CHECK(!memcmp(part, expect + 5, 20));
  stick_cipher_free(&c);
}

void test_store(void) {
  static stick_store_t plain, enc;
  char path[256];

  /* Plain store: record, list, read back. */
  const char *dir_plain = test_dir("plain");
  CHECK_EQ(stick_store_open(&plain, dir_plain, NULL), STICK_OK);
  CHECK_EQ(plain.count, 0);
  uint16_t id = record(&plain, 3.5, 1794470400000ull);
  CHECK_EQ(id, 1);
  const stick_rec_t *r = stick_store_get(&plain, id);
  CHECK(r != NULL);
  const uint32_t blocks = (56000 + STICK_SAMPLES_PER_BLOCK - 1) / STICK_SAMPLES_PER_BLOCK;
  CHECK_EQ(r->size, STICK_WAV_HEADER_LEN + blocks * STICK_BLOCK_ALIGN);
  CHECK_EQ(r->duration_ms, 3500);
  CHECK(r->start_epoch_ms == 1794470400000ull);
  uint32_t size_plain = 0;
  uint8_t *wav_plain = read_all(&plain, id, &size_plain);
  CHECK_EQ(size_plain, r->size);
  stick_wav_info_t info;
  CHECK(stick_wav_parse(wav_plain, size_plain, &info));
  CHECK_EQ(info.samples, 56000);
  CHECK_EQ(info.data_len, blocks * STICK_BLOCK_ALIGN);
  uint32_t got = 0;
  uint8_t tmp[16];
  CHECK_EQ(stick_store_read(&plain, id, r->size, tmp, 16, &got), STICK_ERR_BAD_REQUEST);
  CHECK_EQ(stick_store_read(&plain, 99, 0, tmp, 16, &got), STICK_ERR_NOT_FOUND);

  /* Synced marks and deletions survive a restart; ids keep counting up. */
  uint16_t id2 = record(&plain, 0.5, 0);
  CHECK_EQ(id2, 2);
  CHECK_EQ(stick_store_mark_synced(&plain, id), STICK_OK);
  stick_store_close(&plain);
  CHECK_EQ(stick_store_open(&plain, dir_plain, NULL), STICK_OK);
  CHECK_EQ(plain.count, 2);
  CHECK(stick_store_get(&plain, id)->flags & STICK_REC_SYNCED);
  CHECK(!(stick_store_get(&plain, id2)->flags & STICK_REC_SYNCED));
  CHECK_EQ(stick_store_delete(&plain, id), STICK_OK);
  CHECK_EQ(stick_store_delete(&plain, id), STICK_ERR_NOT_FOUND);
  snprintf(path, sizeof(path), "%s/R00001.SYN", dir_plain);
  CHECK(file_size(path) < 0);
  CHECK_EQ(record(&plain, 0.2, 0), 3);
  stick_store_close(&plain);

  /* A recording cut off by a power loss is repaired at the next start. */
  static stick_recorder_t cut;
  synth_t syn;
  synth_init(&syn, 7);
  CHECK_EQ(stick_store_open(&plain, dir_plain, NULL), STICK_OK);
  CHECK_EQ(stick_recorder_start(&cut, &plain, 1794470400000ull, &id), STICK_OK);
  int16_t pcm[1600];
  for (int i = 0; i < 30; i++) { /* 3 s */
    synth_fill(&syn, pcm, 1600);
    stick_recorder_write(&cut, pcm, 1600);
  }
  fflush(cut.f);
  fclose(cut.f); /* the battery dies: no final header */
  cut.active = false;
  stick_store_close(&plain);
  CHECK_EQ(stick_store_open(&plain, dir_plain, NULL), STICK_OK);
  CHECK_EQ(plain.repaired, 1);
  r = stick_store_get(&plain, id);
  CHECK(r != NULL);
  if (r) {
    const uint32_t whole = 48000 / STICK_SAMPLES_PER_BLOCK;
    CHECK_EQ(r->size, STICK_WAV_HEADER_LEN + whole * STICK_BLOCK_ALIGN);
    CHECK_EQ(r->duration_ms, stick_duration_ms(whole * STICK_SAMPLES_PER_BLOCK, 16000));
    snprintf(path, sizeof(path), "%s/R%05u.WAV", dir_plain, id);
    CHECK_EQ(file_size(path), (long)r->size);
  }
  stick_store_close(&plain);

  if (!stick_crypt_available()) {
    fprintf(stderr, "note: built without AES, skipping encryption tests\n");
    free(wav_plain);
    return;
  }
  test_aes_vectors();

  /* Encrypted store: same plaintext through the API, nothing readable on the card. */
  stick_cipher_t ca, cb;
  uint32_t ctr = 1;
  CHECK(stick_cipher_aes_init(&ca, KEY_A, counter_random, &ctr));
  CHECK(stick_cipher_aes_init(&cb, KEY_B, counter_random, &ctr));
  const char *dir_enc = test_dir("encrypted");
  CHECK_EQ(stick_store_open(&enc, dir_enc, &ca), STICK_OK);
  CHECK(stick_store_encrypted(&enc));
  id = record(&enc, 3.5, 1794470400000ull);
  uint32_t size_enc = 0;
  uint8_t *wav_enc = read_all(&enc, id, &size_enc);
  CHECK_EQ(size_enc, size_plain);
  CHECK(wav_enc && !memcmp(wav_enc, wav_plain, size_plain));
  snprintf(path, sizeof(path), "%s/R%05u.BBY", dir_enc, id);
  CHECK_EQ(file_size(path), (long)size_plain + STICK_ENC_HEADER);
  FILE *f = fopen(path, "rb");
  static uint8_t raw[64 * 1024];
  size_t raw_n = f ? fread(raw, 1, sizeof(raw), f) : 0;
  if (f) fclose(f);
  CHECK(raw_n > 100 && !memcmp(raw, "BBLYENC1", 8));
  int found_riff = 0;
  for (size_t i = 0; i + 4 <= raw_n; i++) found_riff |= !memcmp(raw + i, "RIFF", 4) || !memcmp(raw + i, "WAVE", 4);
  CHECK(!found_riff);
  CHECK(memcmp(raw + STICK_ENC_HEADER + STICK_WAV_HEADER_LEN, wav_plain + STICK_WAV_HEADER_LEN, 256) != 0);
  stick_store_close(&enc);

  /* A card from another Stick (other key) is left alone and never overwritten. */
  CHECK_EQ(stick_store_open(&enc, dir_enc, &cb), STICK_OK);
  CHECK_EQ(enc.count, 0);
  CHECK_EQ(record(&enc, 0.2, 0), id + 1);
  stick_store_close(&enc);
  CHECK_EQ(stick_store_open(&enc, dir_enc, &ca), STICK_OK);
  CHECK_EQ(enc.count, 1);
  stick_store_close(&enc);

  stick_cipher_free(&ca);
  stick_cipher_free(&cb);
  free(wav_plain);
  free(wav_enc);
}
