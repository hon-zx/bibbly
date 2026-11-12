/*
 * Deterministic speech-like test signal for the simulator and tests: voiced
 * "syllables" with a gliding pitch and vowel-like formants, grouped into
 * phrases with pauses, so voice-activity detection and the recorder see
 * something shaped like talking rather than a test tone.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t rng;
  uint32_t left;      /* samples left in the current segment */
  int voiced;         /* 1 while in a syllable */
  int syllables_left; /* in the current phrase */
  uint32_t length;    /* length of the current segment */
  float f0, f0_step;
  float phase;
  float amps[24];
  int harmonics;
} synth_t;

void synth_init(synth_t *s, uint32_t seed);
void synth_fill(synth_t *s, int16_t *out, size_t n);
