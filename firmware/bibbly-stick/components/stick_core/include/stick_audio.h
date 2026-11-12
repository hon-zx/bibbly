/*
 * Audio formats used by the Stick's recorder.
 *
 * Recordings are mono 16 kHz IMA ADPCM WAV files (format 0x0011, 512-byte
 * blocks, 1017 samples per block) with a "fact" chunk and a Bibbly "bbly"
 * chunk holding the start time. The layout is fixed and byte-identical to
 * encodeWavIma() in packages/core/src/audio/wav.ts, which the host tests check.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define STICK_SAMPLE_RATE 16000
#define STICK_BLOCK_ALIGN 512
#define STICK_SAMPLES_PER_BLOCK ((STICK_BLOCK_ALIGN - 4) * 2 + 1) /* 1017 */
#define STICK_WAV_HEADER_LEN 80
#define STICK_BBLY_FLAGS 1u /* bit 0: Bibbly recording format v1 */

/* Byte offsets of the fields the recorder patches when it finishes a file. */
#define STICK_WAV_OFF_RIFF_SIZE 4
#define STICK_WAV_OFF_FACT_SAMPLES 48
#define STICK_WAV_OFF_DATA_LEN 76

typedef struct {
  int16_t predictor;
  uint8_t index;
} stick_ima_state_t;

uint8_t stick_ima_encode_sample(int16_t sample, stick_ima_state_t *st);
int16_t stick_ima_decode_nibble(uint8_t nibble, stick_ima_state_t *st);

/*
 * Encodes one block of up to STICK_SAMPLES_PER_BLOCK samples into STICK_BLOCK_ALIGN
 * bytes. Missing samples are encoded as silence. The block header resets the
 * predictor to the first sample; the step index carries over in `st`.
 */
void stick_ima_encode_block(const int16_t *samples, size_t n, stick_ima_state_t *st, uint8_t *out);

/* Decodes one block; returns the number of samples written (at most max_samples). */
size_t stick_ima_decode_block(const uint8_t *block, size_t block_len, int16_t *out, size_t max_samples);

typedef struct {
  uint32_t sample_rate;
  uint16_t block_align;
  uint16_t samples_per_block;
  uint32_t samples;  /* from the fact chunk */
  uint32_t data_len; /* bytes of ADPCM data */
  uint32_t flags;    /* bbly flags */
  uint64_t start_epoch_ms;
} stick_wav_info_t;

/* Writes the 80-byte header. */
void stick_wav_header(uint8_t out[STICK_WAV_HEADER_LEN], uint32_t sample_rate, uint32_t samples, uint32_t data_len,
                      uint64_t start_epoch_ms);

/* Parses a header written by stick_wav_header. Returns false for anything else. */
bool stick_wav_parse(const uint8_t *buf, size_t len, stick_wav_info_t *out);

/* Duration in milliseconds of `samples` at `rate`. */
uint32_t stick_duration_ms(uint32_t samples, uint32_t rate);

/* Level of a block of samples in tenths of a dB relative to full scale, floored at -100.0 dB. */
int16_t stick_level_db10(const int16_t *pcm, size_t n);

#ifdef __cplusplus
}
#endif
