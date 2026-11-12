/*
 * Microphones: a pair of PDM MEMS microphones on I2S0 (the ESP32-S3 converts
 * PDM to 16 kHz PCM in hardware). Every 10 ms the mic task runs the DSP chain
 * from stick_core and sends the result to USB (when a host is listening) and
 * to the recorder's ring buffer (while recording).
 */
#include <stdatomic.h>
#include <string.h>

#include "bibbly.h"
#include "driver/i2s_pdm.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "stick_dsp.h"

static const char *TAG = "mic";

#if CONFIG_BIBBLY_MIC_PAIR
#define MIC_CHANNELS 2
#else
#define MIC_CHANNELS 1
#endif
#define FRAME 160 /* 10 ms at 16 kHz */

static i2s_chan_handle_t s_rx;
static stick_dsp_t s_dsp;
static stick_ringbuf_t s_rec;
static uint8_t s_rec_mem[64 * 1024]; /* 2 s of audio: rides out slow microSD writes */
static atomic_bool s_recording;
static atomic_bool s_muted;
static atomic_int s_mode_req = -1;
static atomic_int s_level = -1000;

void mic_set_mode(uint8_t mode) { atomic_store(&s_mode_req, mode); }
void mic_set_muted(bool muted) { atomic_store(&s_muted, muted); }
int16_t mic_level_db10(void) { return (int16_t)atomic_load(&s_level); }

void mic_set_recording(bool on) {
  if (on) stick_rb_clear(&s_rec);
  atomic_store(&s_recording, on);
}

size_t mic_read_recording(int16_t *pcm, size_t max_samples) {
  return stick_rb_read(&s_rec, pcm, max_samples * sizeof(int16_t)) / sizeof(int16_t);
}

static void mic_task(void *arg) {
  (void)arg;
  static int16_t raw[FRAME * MIC_CHANNELS];
  static int16_t mono[FRAME];
  uint32_t dropped = 0;
  for (;;) {
    size_t got = 0;
    if (i2s_channel_read(s_rx, raw, sizeof(raw), &got, portMAX_DELAY) != ESP_OK || got == 0) continue;
    const size_t frames = got / (MIC_CHANNELS * sizeof(int16_t));
    const int mode = atomic_exchange(&s_mode_req, -1);
    if (mode >= 0) stick_dsp_set_mode(&s_dsp, (uint8_t)mode);
    stick_dsp_set_volume_db(&s_dsp, usb_host_volume_db());
    stick_dsp_process(&s_dsp, raw, frames, MIC_CHANNELS, mono);
    atomic_store(&s_level, stick_level_db10(mono, frames));

    /* The Stick's own mute silences both the call and the recording. */
    if (atomic_load(&s_muted)) memset(mono, 0, frames * sizeof(int16_t));
    if (atomic_load(&s_recording)) {
      if (stick_rb_write(&s_rec, mono, frames * sizeof(int16_t)) < frames * sizeof(int16_t) && (dropped++ % 100) == 0)
        ESP_LOGW(TAG, "recorder fell behind: audio dropped (card too slow?)");
      app_notify(APP_EVT_AUDIO);
    }
    if (usb_streaming()) {
      if (usb_host_muted()) memset(mono, 0, frames * sizeof(int16_t));
      usb_mic_write(mono, frames);
    }
  }
}

void mic_start(uint8_t mode) {
  stick_dsp_init(&s_dsp, mode);
  stick_rb_init(&s_rec, s_rec_mem, sizeof(s_rec_mem));

  i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan_cfg.dma_frame_num = FRAME;
  ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, NULL, &s_rx));
  i2s_pdm_rx_config_t cfg = {
      .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG(STICK_SAMPLE_RATE),
      .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                 MIC_CHANNELS == 2 ? I2S_SLOT_MODE_STEREO : I2S_SLOT_MODE_MONO),
      .gpio_cfg =
          {
              .clk = (gpio_num_t)CONFIG_BIBBLY_PIN_PDM_CLK,
              .din = (gpio_num_t)CONFIG_BIBBLY_PIN_PDM_DATA,
              .invert_flags = {.clk_inv = false},
          },
  };
  ESP_ERROR_CHECK(i2s_channel_init_pdm_rx_mode(s_rx, &cfg));
  ESP_ERROR_CHECK(i2s_channel_enable(s_rx));
  xTaskCreatePinnedToCore(mic_task, "mic", 4096, NULL, configMAX_PRIORITIES - 3, NULL, 1);
  ESP_LOGI(TAG, "%d PDM microphone(s) at %d Hz", MIC_CHANNELS, STICK_SAMPLE_RATE);
}
