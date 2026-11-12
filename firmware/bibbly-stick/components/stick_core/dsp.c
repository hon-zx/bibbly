#include "stick_dsp.h"

#include <math.h>
#include <string.h>

#include "stick_link.h"

static const stick_dsp_profile_t PROFILES[STICK_MODE_COUNT] = {
    /* hp_r,   target, max_gain, attack, release, gate */
    {0.9902f, 0.10f, 8.0f, 0.20f, 0.0008f, 0.0015f},  /* meeting mic: ~25 Hz high-pass */
    {0.9941f, 0.12f, 4.0f, 0.30f, 0.0020f, 0.0030f},  /* pocket recorder: ~15 Hz */
    {0.9853f, 0.10f, 16.0f, 0.15f, 0.0005f, 0.0010f}, /* room: ~38 Hz */
};

void stick_dsp_init(stick_dsp_t *d, uint8_t mode) {
  memset(d, 0, sizeof(*d));
  d->gain = 1.0f;
  d->user_gain = 1.0f;
  stick_dsp_set_mode(d, mode);
}

void stick_dsp_set_mode(stick_dsp_t *d, uint8_t mode) {
  d->p = PROFILES[mode < STICK_MODE_COUNT ? mode : 0];
  if (d->gain > d->p.max_gain) d->gain = d->p.max_gain;
}

void stick_dsp_set_volume_db(stick_dsp_t *d, float db) {
  if (db < -40.0f) db = -40.0f;
  if (db > 20.0f) db = 20.0f;
  d->user_gain = powf(10.0f, db / 20.0f);
}

void stick_dsp_process(stick_dsp_t *d, const int16_t *in, size_t frames, int channels, int16_t *out) {
  if (channels < 1) channels = 1;
  if (channels > 2) channels = 2;
  const float k = 1.0f / 32768.0f;
  for (size_t i = 0; i < frames; i++) {
    float mixed = 0.0f;
    for (int ch = 0; ch < channels; ch++) {
      const float x = (float)in[i * (size_t)channels + (size_t)ch] * k;
      const float y = x - d->x1[ch] + d->p.hp_r * d->y1[ch]; /* DC blocker */
      d->x1[ch] = x;
      d->y1[ch] = y;
      mixed += y;
    }
    mixed /= (float)channels; /* in-phase sum of the pair: speech adds up, mic self-noise averages down */

    const float level = fabsf(mixed);
    d->env += (level > d->env ? d->p.attack : d->p.release) * (level - d->env);
    if (d->env > d->p.gate) {
      float want = d->p.target / (d->env * 1.414f + 1e-6f);
      if (want > d->p.max_gain) want = d->p.max_gain;
      if (want < 0.25f) want = 0.25f;
      d->gain += (want < d->gain ? 0.01f : 0.0005f) * (want - d->gain); /* duck fast, recover slowly */
    }
    float v = mixed * d->gain * d->user_gain;
    /* Soft limiter above -3 dBFS keeps peaks from clipping harshly. */
    const float knee = 0.708f;
    const float a = fabsf(v);
    if (a > knee) v = copysignf(knee + (1.0f - knee) * tanhf((a - knee) / (1.0f - knee)), v);
    int32_t s = (int32_t)lrintf(v * 32767.0f);
    out[i] = (int16_t)(s > 32767 ? 32767 : s < -32768 ? -32768 : s);
  }
}

bool stick_rb_init(stick_ringbuf_t *rb, uint8_t *storage, size_t cap) {
  if (cap == 0 || (cap & (cap - 1)) != 0) return false;
  rb->buf = storage;
  rb->cap = cap;
  atomic_init(&rb->head, 0);
  atomic_init(&rb->tail, 0);
  return true;
}

size_t stick_rb_used(stick_ringbuf_t *rb) {
  return atomic_load_explicit(&rb->head, memory_order_acquire) - atomic_load_explicit(&rb->tail, memory_order_acquire);
}

size_t stick_rb_write(stick_ringbuf_t *rb, const void *data, size_t len) {
  const size_t head = atomic_load_explicit(&rb->head, memory_order_relaxed);
  const size_t tail = atomic_load_explicit(&rb->tail, memory_order_acquire);
  const size_t room = rb->cap - (head - tail);
  if (len > room) len = room;
  const uint8_t *src = (const uint8_t *)data;
  for (size_t i = 0; i < len;) {
    const size_t at = (head + i) & (rb->cap - 1);
    size_t n = rb->cap - at;
    if (n > len - i) n = len - i;
    memcpy(rb->buf + at, src + i, n);
    i += n;
  }
  atomic_store_explicit(&rb->head, head + len, memory_order_release);
  return len;
}

size_t stick_rb_read(stick_ringbuf_t *rb, void *out, size_t len) {
  const size_t tail = atomic_load_explicit(&rb->tail, memory_order_relaxed);
  const size_t head = atomic_load_explicit(&rb->head, memory_order_acquire);
  const size_t avail = head - tail;
  if (len > avail) len = avail;
  uint8_t *dst = (uint8_t *)out;
  for (size_t i = 0; i < len;) {
    const size_t at = (tail + i) & (rb->cap - 1);
    size_t n = rb->cap - at;
    if (n > len - i) n = len - i;
    memcpy(dst + i, rb->buf + at, n);
    i += n;
  }
  atomic_store_explicit(&rb->tail, tail + len, memory_order_release);
  return len;
}

void stick_rb_clear(stick_ringbuf_t *rb) {
  atomic_store_explicit(&rb->tail, atomic_load_explicit(&rb->head, memory_order_acquire), memory_order_release);
}
