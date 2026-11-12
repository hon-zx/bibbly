#include "synth.h"

#include <math.h>
#include <string.h>

#define RATE 16000.0f
#define TWO_PI 6.28318530718f

static uint32_t next(synth_t *s) {
  uint32_t x = s->rng;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  return s->rng = x;
}

static float uniform(synth_t *s, float lo, float hi) { return lo + (hi - lo) * (float)(next(s) % 10000) / 10000.0f; }

static float bump(float f, float centre, float width) {
  const float x = (f - centre) / width;
  return expf(-x * x);
}

static void start_segment(synth_t *s) {
  if (s->voiced) {
    /* After a syllable: a short gap inside the phrase, or a pause between phrases. */
    s->voiced = 0;
    const int phrase_over = --s->syllables_left <= 0;
    s->length = (uint32_t)(RATE * (phrase_over ? uniform(s, 0.35f, 0.8f) : uniform(s, 0.03f, 0.08f)));
  } else {
    if (s->syllables_left <= 0) s->syllables_left = 3 + (int)(next(s) % 6);
    s->voiced = 1;
    s->length = (uint32_t)(RATE * uniform(s, 0.14f, 0.26f));
    const float f0 = uniform(s, 120.0f, 200.0f);
    s->f0 = f0;
    s->f0_step = (uniform(s, 0.85f, 1.1f) * f0 - f0) / (float)s->length; /* gentle glide, mostly downwards */
    const float f1 = uniform(s, 450.0f, 800.0f), f2 = uniform(s, 1000.0f, 2300.0f);
    s->harmonics = 0;
    for (int k = 1; k <= 24 && k * f0 < 4000.0f; k++) {
      const float f = (float)k * f0;
      s->amps[k - 1] = bump(f, f1, 160.0f) + 0.6f * bump(f, f2, 260.0f) + 0.04f;
      s->harmonics = k;
    }
  }
  s->left = s->length;
}

void synth_init(synth_t *s, uint32_t seed) {
  memset(s, 0, sizeof(*s));
  s->rng = seed ? seed : 0x9e3779b9u;
  s->voiced = 1; /* begin with a short pause */
  s->syllables_left = 1;
  start_segment(s);
}

void synth_fill(synth_t *s, int16_t *out, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s->left == 0) start_segment(s);
    float v = 0.0f;
    if (s->voiced) {
      const uint32_t pos = s->length - s->left;
      const float attack = fminf(1.0f, (float)pos / (0.02f * RATE));
      const float release = fminf(1.0f, (float)s->left / (0.04f * RATE));
      for (int k = 1; k <= s->harmonics; k++) v += s->amps[k - 1] * sinf(s->phase * (float)k);
      v *= 0.06f * attack * release;
      s->phase += TWO_PI * s->f0 / RATE;
      if (s->phase > TWO_PI) s->phase -= TWO_PI;
      s->f0 += s->f0_step;
    }
    v += ((float)(next(s) % 2001) - 1000.0f) * 0.0000012f; /* room noise around -60 dBFS */
    int32_t x = (int32_t)lrintf(v * 32767.0f);
    out[i] = (int16_t)(x > 32767 ? 32767 : x < -32768 ? -32768 : x);
    s->left--;
  }
}
