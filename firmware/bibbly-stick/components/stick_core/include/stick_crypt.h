/*
 * At-rest encryption for recordings: AES-256 in counter mode, keyed per device.
 *
 * Counter mode lets the Stick decrypt any byte range on its own, which the
 * link's chunked Read needs, and patch header fields in place when a recording
 * finishes. The counter block is the file's 12-byte random nonce followed by
 * the big-endian index of the 16-byte block within the plaintext.
 *
 * Builds without mbedTLS (STICK_HAVE_MBEDTLS undefined) get no cipher, and the
 * store then keeps recordings as plain WAV files.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define STICK_KEY_LEN 32
#define STICK_NONCE_LEN 12

typedef struct stick_cipher {
  /* XORs the keystream for (nonce, plaintext byte offset) into buf; encrypts and decrypts. */
  void (*xcrypt)(struct stick_cipher *c, const uint8_t nonce[STICK_NONCE_LEN], uint64_t offset, uint8_t *buf,
                 size_t len);
  /* Fills out with random bytes (for nonces). */
  void (*random)(void *ctx, uint8_t *out, size_t len);
  void *random_ctx;
  void *impl;
} stick_cipher_t;

/* True when this build includes AES (mbedTLS). */
bool stick_crypt_available(void);

/*
 * Sets up AES-256-CTR with `key`. Returns false when the build has no AES.
 * `random` supplies nonces; the device passes its hardware RNG.
 */
bool stick_cipher_aes_init(stick_cipher_t *c, const uint8_t key[STICK_KEY_LEN],
                           void (*random)(void *ctx, uint8_t *out, size_t len), void *random_ctx);
void stick_cipher_free(stick_cipher_t *c);

#ifdef __cplusplus
}
#endif
