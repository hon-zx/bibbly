/*
 * Microphone processing that runs before audio goes to USB or the recorder:
 * DC and rumble removal, mixing the microphone pair, and automatic gain so
 * quiet talkers across the table still reach the speech engine at a usable
 * level. Each Stick mode uses a tuned profile:
 *
 *   Meeting mic      table in a small room, gentle gain
 *   Pocket recorder  close talk and voice memos, faster gain, less boost
 *   Room mode        larger rooms, more boost and more rumble removal
 *
 * Also: a lock-free single-producer/single-consumer ring buffer for moving
 * audio between the microphone task and its consumers.
 */
#pragma once

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  float hp_r;        /* DC blocker pole */
  float target;      /* AGC target RMS (linear, full scale = 1) */
  float max_gain;    /* AGC ceiling */
  float attack;      /* envelope smoothing when louder */
  float release;     /* envelope smoothing when quieter */
  float gate;        /* below this envelope the gain stops rising */
} stick_dsp_profile_t;

typedef struct {
  stick_dsp_profile_t p;
  float x1[2], y1[2]; /* DC blocker state per channel */
  float env;          /* smoothed level */
  float gain;         /* current gain */
  float user_gain;    /* host volume control, linear */
} stick_dsp_t;

void stick_dsp_init(stick_dsp_t *d, uint8_t mode);
void stick_dsp_set_mode(stick_dsp_t *d, uint8_t mode);
/* Host volume in dB (USB Audio feature unit), clamped to -40..+20 dB. */
void stick_dsp_set_volume_db(stick_dsp_t *d, float db);
/* Processes `frames` frames of interleaved `channels`-channel PCM (1 or 2) into mono `out`. */
void stick_dsp_process(stick_dsp_t *d, const int16_t *in, size_t frames, int channels, int16_t *out);

typedef struct {
  uint8_t *buf;
  size_t cap; /* power of two */
  atomic_size_t head; /* written by the producer */
  atomic_size_t tail; /* written by the consumer */
} stick_ringbuf_t;

/* `cap` must be a power of two. */
bool stick_rb_init(stick_ringbuf_t *rb, uint8_t *storage, size_t cap);
/* Writes up to len bytes; returns how many fitted. */
size_t stick_rb_write(stick_ringbuf_t *rb, const void *data, size_t len);
size_t stick_rb_read(stick_ringbuf_t *rb, void *out, size_t len);
size_t stick_rb_used(stick_ringbuf_t *rb);
void stick_rb_clear(stick_ringbuf_t *rb); /* consumer side */

#ifdef __cplusplus
}
#endif
