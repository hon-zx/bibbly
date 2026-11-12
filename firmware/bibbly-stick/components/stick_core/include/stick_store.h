/*
 * Recording storage: a directory of WAV recordings with an in-memory index.
 *
 * Uses only stdio, dirent and unistd, which ESP-IDF provides on top of FATFS,
 * so the same code runs on the Stick (microSD at /sdcard/REC) and in the host
 * simulator (a temporary directory).
 *
 * Files are named R<id>.BBY when encrypted, or R<id>.WAV in builds without
 * AES. An encrypted file is a 32-byte header ("BBLYENC1", 12-byte nonce,
 * key id, reserved) followed by the AES-256-CTR encrypted WAV. An empty
 * R<id>.SYN file marks a recording the app has imported. Sizes and offsets in
 * this API always refer to the plaintext WAV.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "stick_audio.h"
#include "stick_crypt.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef STICK_MAX_RECORDINGS
#define STICK_MAX_RECORDINGS 512
#endif

#define STICK_ENC_HEADER 32
#define STICK_ENC_KEY_ID 1u
#define STICK_REC_SYNCED 0x01

typedef struct {
  uint16_t id;
  uint8_t flags;
  uint32_t size; /* plaintext WAV bytes */
  uint64_t start_epoch_ms;
  uint32_t duration_ms;
} stick_rec_t;

typedef struct {
  char dir[96];
  stick_cipher_t *cipher; /* NULL: plain WAV files */
  stick_rec_t recs[STICK_MAX_RECORDINGS];
  uint16_t count;
  uint16_t next_id;
  uint16_t active_id; /* recording in progress, kept out of the list */
  uint32_t repaired;  /* files fixed at open after a power loss */
  /* One-file cache for chunked downloads. */
  FILE *rf;
  uint16_t rf_id;
  uint32_t rf_hdr;
  uint8_t rf_nonce[STICK_NONCE_LEN];
} stick_store_t;

/* Opens (creating if needed) the directory, indexes it and repairs unfinished recordings. */
int stick_store_open(stick_store_t *s, const char *dir, stick_cipher_t *cipher);
void stick_store_close(stick_store_t *s);

const stick_rec_t *stick_store_get(const stick_store_t *s, uint16_t id);
int stick_store_read(stick_store_t *s, uint16_t id, uint32_t offset, uint8_t *buf, uint32_t len, uint32_t *got);
int stick_store_delete(stick_store_t *s, uint16_t id);
int stick_store_mark_synced(stick_store_t *s, uint16_t id);
/* Bytes the recordings occupy on disk, headers included. */
uint64_t stick_store_bytes(const stick_store_t *s);
bool stick_store_encrypted(const stick_store_t *s);

/* Streams PCM into a new recording, one ADPCM block at a time. */
typedef struct {
  stick_store_t *store;
  FILE *f;
  uint16_t id;
  uint32_t hdr;
  uint8_t nonce[STICK_NONCE_LEN];
  stick_ima_state_t st;
  int16_t pcm[STICK_SAMPLES_PER_BLOCK];
  size_t fill;
  uint32_t samples;
  uint32_t blocks;
  uint64_t start_epoch_ms;
  uint8_t block[STICK_BLOCK_ALIGN];
  bool active;
} stick_recorder_t;

int stick_recorder_start(stick_recorder_t *r, stick_store_t *s, uint64_t start_epoch_ms, uint16_t *id);
int stick_recorder_write(stick_recorder_t *r, const int16_t *pcm, size_t n);
/* Pushes buffered data to the card so a power cut loses at most the last few seconds. */
int stick_recorder_flush(stick_recorder_t *r);
/* Finishes the file (pads the last block, writes the final header) and adds it to the index. */
int stick_recorder_stop(stick_recorder_t *r, uint16_t *id);
/* Discards the recording in progress (used when the card fails mid-recording). */
void stick_recorder_abort(stick_recorder_t *r);
uint32_t stick_recorder_ms(const stick_recorder_t *r);
/* Plaintext WAV bytes written so far, including the header and buffered samples. */
uint64_t stick_recorder_bytes(const stick_recorder_t *r);

#ifdef __cplusplus
}
#endif
