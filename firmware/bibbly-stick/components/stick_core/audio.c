#include "stick_audio.h"

#include <math.h>
#include <string.h>

static const int16_t step_table[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,    21,    23,    25,    28,
    31,    34,    37,    41,    45,    50,    55,    60,    66,    73,    80,    88,    97,    107,   118,
    130,   143,   157,   173,   190,   209,   230,   253,   279,   307,   337,   371,   408,   449,   494,
    544,   598,   658,   724,   796,   876,   963,   1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,
    2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,  4871,  5358,  5894,  6484,  7132,  7845,  8630,
    9493,  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};

static const int8_t index_table[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};

static int16_t clamp16(int32_t v) { return (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v); }

static uint8_t next_index(uint8_t index, uint8_t nibble) {
  int v = (int)index + index_table[nibble & 0x0f];
  return (uint8_t)(v < 0 ? 0 : v > 88 ? 88 : v);
}

int16_t stick_ima_decode_nibble(uint8_t nibble, stick_ima_state_t *st) {
  const int32_t step = step_table[st->index];
  int32_t diff = step >> 3;
  if (nibble & 4) diff += step;
  if (nibble & 2) diff += step >> 1;
  if (nibble & 1) diff += step >> 2;
  st->predictor = clamp16((nibble & 8) ? st->predictor - diff : st->predictor + diff);
  st->index = next_index(st->index, nibble);
  return st->predictor;
}

uint8_t stick_ima_encode_sample(int16_t sample, stick_ima_state_t *st) {
  const int32_t step = step_table[st->index];
  int32_t diff = (int32_t)sample - st->predictor;
  uint8_t nibble = 0;
  if (diff < 0) {
    nibble = 8;
    diff = -diff;
  }
  int32_t delta = step >> 3;
  if (diff >= step) {
    nibble |= 4;
    diff -= step;
    delta += step;
  }
  if (diff >= step >> 1) {
    nibble |= 2;
    diff -= step >> 1;
    delta += step >> 1;
  }
  if (diff >= step >> 2) {
    nibble |= 1;
    delta += step >> 2;
  }
  st->predictor = clamp16((nibble & 8) ? st->predictor - delta : st->predictor + delta);
  st->index = next_index(st->index, nibble);
  return nibble;
}

void stick_ima_encode_block(const int16_t *samples, size_t n, stick_ima_state_t *st, uint8_t *out) {
  const int16_t first = n ? samples[0] : 0;
  st->predictor = first;
  out[0] = (uint8_t)(first & 0xff);
  out[1] = (uint8_t)(((uint16_t)first >> 8) & 0xff);
  out[2] = st->index;
  out[3] = 0;
  for (size_t i = 1; i < STICK_SAMPLES_PER_BLOCK; i += 2) {
    const uint8_t lo = stick_ima_encode_sample(i < n ? samples[i] : 0, st);
    const uint8_t hi = stick_ima_encode_sample(i + 1 < n ? samples[i + 1] : 0, st);
    out[4 + ((i - 1) >> 1)] = (uint8_t)(lo | (hi << 4));
  }
}

size_t stick_ima_decode_block(const uint8_t *block, size_t block_len, int16_t *out, size_t max_samples) {
  if (block_len < 4 || max_samples == 0) return 0;
  stick_ima_state_t st = {.predictor = (int16_t)(block[0] | (block[1] << 8)), .index = block[2] > 88 ? 88 : block[2]};
  size_t n = 0;
  out[n++] = st.predictor;
  for (size_t i = 4; i < block_len && n < max_samples; i++) {
    out[n++] = stick_ima_decode_nibble(block[i] & 0x0f, &st);
    if (n < max_samples) out[n++] = stick_ima_decode_nibble(block[i] >> 4, &st);
  }
  return n;
}

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

void stick_wav_header(uint8_t out[STICK_WAV_HEADER_LEN], uint32_t sample_rate, uint32_t samples, uint32_t data_len,
                      uint64_t start_epoch_ms) {
  const uint32_t spb = STICK_SAMPLES_PER_BLOCK;
  /* Math.round(rate * blockAlign / spb) in wav.ts, done exactly in integers. */
  const uint32_t byte_rate = (uint32_t)((2ull * sample_rate * STICK_BLOCK_ALIGN + spb) / (2ull * spb));
  memcpy(out + 0, "RIFF", 4);
  put32(out + 4, STICK_WAV_HEADER_LEN - 8 + data_len);
  memcpy(out + 8, "WAVE", 4);
  memcpy(out + 12, "fmt ", 4);
  put32(out + 16, 20);
  put16(out + 20, 0x11);
  put16(out + 22, 1);
  put32(out + 24, sample_rate);
  put32(out + 28, byte_rate);
  put16(out + 32, STICK_BLOCK_ALIGN);
  put16(out + 34, 4);
  put16(out + 36, 2);
  put16(out + 38, (uint16_t)spb);
  memcpy(out + 40, "fact", 4);
  put32(out + 44, 4);
  put32(out + 48, samples);
  memcpy(out + 52, "bbly", 4);
  put32(out + 56, 12);
  put32(out + 60, STICK_BBLY_FLAGS);
  put32(out + 64, (uint32_t)start_epoch_ms);
  put32(out + 68, (uint32_t)(start_epoch_ms >> 32));
  memcpy(out + 72, "data", 4);
  put32(out + 76, data_len);
}

bool stick_wav_parse(const uint8_t *buf, size_t len, stick_wav_info_t *out) {
  if (len < STICK_WAV_HEADER_LEN) return false;
  if (memcmp(buf, "RIFF", 4) || memcmp(buf + 8, "WAVE", 4) || memcmp(buf + 12, "fmt ", 4) ||
      memcmp(buf + 40, "fact", 4) || memcmp(buf + 52, "bbly", 4) || memcmp(buf + 72, "data", 4))
    return false;
  if (get16(buf + 20) != 0x11 || get16(buf + 22) != 1 || get32(buf + 16) != 20) return false;
  out->sample_rate = get32(buf + 24);
  out->block_align = get16(buf + 32);
  out->samples_per_block = get16(buf + 38);
  out->samples = get32(buf + 48);
  out->flags = get32(buf + 60);
  out->start_epoch_ms = (uint64_t)get32(buf + 64) | ((uint64_t)get32(buf + 68) << 32);
  out->data_len = get32(buf + 76);
  return out->sample_rate > 0 && out->block_align == STICK_BLOCK_ALIGN &&
         out->samples_per_block == STICK_SAMPLES_PER_BLOCK;
}

uint32_t stick_duration_ms(uint32_t samples, uint32_t rate) {
  return rate ? (uint32_t)(((uint64_t)samples * 1000u) / rate) : 0;
}

int16_t stick_level_db10(const int16_t *pcm, size_t n) {
  if (!n) return -1000;
  double sum = 0;
  for (size_t i = 0; i < n; i++) sum += (double)pcm[i] * pcm[i];
  const double rms = sqrt(sum / (double)n) / 32768.0;
  if (rms <= 1e-5) return -1000;
  double db = 20.0 * log10(rms);
  if (db < -100.0) db = -100.0;
  return (int16_t)lround(db * 10.0);
}
