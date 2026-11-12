/*
 * Storage: the microSD card (FAT32, 4-bit SDMMC) holding recordings, and the
 * per-device AES-256 key that encrypts them, kept in NVS. With flash and NVS
 * encryption on (sdkconfig.defaults.release) the key never leaves the chip in
 * readable form, so a card pulled from the Stick is unreadable on its own.
 */
#include <string.h>

#include "bibbly.h"
#include "driver/sdmmc_host.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_vfs_fat.h"
#include "nvs.h"
#include "sdmmc_cmd.h"

static const char *TAG = "storage";

#define MOUNT_POINT "/sdcard"
#define REC_DIR MOUNT_POINT "/REC"

static sdmmc_card_t *s_card;

bool storage_key(uint8_t key[32]) {
  nvs_handle_t h;
  if (nvs_open("bibbly", NVS_READWRITE, &h) != ESP_OK) return false;
  size_t len = 32;
  esp_err_t err = nvs_get_blob(h, "rec_key", key, &len);
  if (err == ESP_ERR_NVS_NOT_FOUND) {
    /* First boot: a fresh random key from the hardware RNG (seeded by the radio). */
    esp_fill_random(key, 32);
    len = 32;
    err = nvs_set_blob(h, "rec_key", key, 32);
    if (err == ESP_OK) err = nvs_commit(h);
    ESP_LOGI(TAG, "created a new recording key");
  }
  nvs_close(h);
  return err == ESP_OK && len == 32;
}

stick_store_t *storage_start(stick_store_t *store, stick_cipher_t *cipher) {
#if CONFIG_BIBBLY_SD
  const esp_vfs_fat_mount_config_t mount = {
      .format_if_mount_failed = false, /* never wipe someone's card */
      .max_files = 4,
      .allocation_unit_size = 32 * 1024,
  };
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.max_freq_khz = SDMMC_FREQ_HIGHSPEED;
  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.clk = (gpio_num_t)CONFIG_BIBBLY_PIN_SD_CLK;
  slot.cmd = (gpio_num_t)CONFIG_BIBBLY_PIN_SD_CMD;
  slot.d0 = (gpio_num_t)CONFIG_BIBBLY_PIN_SD_D0;
#if CONFIG_BIBBLY_SD_4BIT
  slot.width = 4;
  slot.d1 = (gpio_num_t)CONFIG_BIBBLY_PIN_SD_D1;
  slot.d2 = (gpio_num_t)CONFIG_BIBBLY_PIN_SD_D2;
  slot.d3 = (gpio_num_t)CONFIG_BIBBLY_PIN_SD_D3;
#else
  slot.width = 1;
#endif
  slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
  esp_err_t err = esp_vfs_fat_sdmmc_mount(MOUNT_POINT, &host, &slot, &mount, &s_card);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "no usable microSD card (%s); a FAT32 card is needed for recordings", esp_err_to_name(err));
    s_card = NULL;
    return NULL;
  }
  if (stick_store_open(store, REC_DIR, cipher) != STICK_OK) {
    ESP_LOGE(TAG, "cannot open %s", REC_DIR);
    esp_vfs_fat_sdcard_unmount(MOUNT_POINT, s_card);
    s_card = NULL;
    return NULL;
  }
  ESP_LOGI(TAG, "%s: %u recording(s)%s", s_card->cid.name, store->count,
           store->repaired ? ", repaired unfinished recordings" : "");
  return store;
#else
  (void)store;
  (void)cipher;
  return NULL;
#endif
}

void storage_stop(stick_store_t *store) {
  stick_store_close(store);
  if (s_card) esp_vfs_fat_sdcard_unmount(MOUNT_POINT, s_card);
  s_card = NULL;
}

void storage_space(void *ctx, uint64_t *total, uint64_t *free_bytes) {
  (void)ctx;
  if (!s_card || esp_vfs_fat_info(MOUNT_POINT, total, free_bytes) != ESP_OK) *total = *free_bytes = 0;
}
