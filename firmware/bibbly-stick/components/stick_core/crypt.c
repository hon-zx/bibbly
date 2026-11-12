#include "stick_crypt.h"

#include <stdlib.h>
#include <string.h>

#ifdef STICK_HAVE_MBEDTLS
#include "mbedtls/aes.h"

typedef struct {
  mbedtls_aes_context aes;
} aes_impl_t;

static void aes_ctr_xcrypt(stick_cipher_t *c, const uint8_t nonce[STICK_NONCE_LEN], uint64_t offset, uint8_t *buf,
                           size_t len) {
  aes_impl_t *impl = (aes_impl_t *)c->impl;
  uint8_t counter[16], stream[16];
  memcpy(counter, nonce, STICK_NONCE_LEN);
  uint32_t block = (uint32_t)(offset / 16);
  size_t skip = (size_t)(offset % 16);
  while (len) {
    counter[12] = (uint8_t)(block >> 24);
    counter[13] = (uint8_t)(block >> 16);
    counter[14] = (uint8_t)(block >> 8);
    counter[15] = (uint8_t)block;
    mbedtls_aes_crypt_ecb(&impl->aes, MBEDTLS_AES_ENCRYPT, counter, stream);
    for (size_t i = skip; i < 16 && len; i++, len--) *buf++ ^= stream[i];
    skip = 0;
    block++;
  }
  memset(stream, 0, sizeof(stream));
}

bool stick_crypt_available(void) { return true; }

bool stick_cipher_aes_init(stick_cipher_t *c, const uint8_t key[STICK_KEY_LEN],
                           void (*random)(void *ctx, uint8_t *out, size_t len), void *random_ctx) {
  memset(c, 0, sizeof(*c));
  aes_impl_t *impl = (aes_impl_t *)calloc(1, sizeof(aes_impl_t));
  if (!impl) return false;
  mbedtls_aes_init(&impl->aes);
  if (mbedtls_aes_setkey_enc(&impl->aes, key, STICK_KEY_LEN * 8) != 0) {
    mbedtls_aes_free(&impl->aes);
    free(impl);
    return false;
  }
  c->impl = impl;
  c->xcrypt = aes_ctr_xcrypt;
  c->random = random;
  c->random_ctx = random_ctx;
  return true;
}

void stick_cipher_free(stick_cipher_t *c) {
  if (c->impl) {
    aes_impl_t *impl = (aes_impl_t *)c->impl;
    mbedtls_aes_free(&impl->aes);
    free(impl);
  }
  memset(c, 0, sizeof(*c));
}

#else

bool stick_crypt_available(void) { return false; }

bool stick_cipher_aes_init(stick_cipher_t *c, const uint8_t key[STICK_KEY_LEN],
                           void (*random)(void *ctx, uint8_t *out, size_t len), void *random_ctx) {
  (void)key;
  (void)random;
  (void)random_ctx;
  memset(c, 0, sizeof(*c));
  return false;
}

void stick_cipher_free(stick_cipher_t *c) { memset(c, 0, sizeof(*c)); }

#endif
