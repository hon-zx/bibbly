/*
 * TinyUSB configuration for the Bibbly Stick: full-speed device with
 *   - USB Audio Class 2.0 microphone, mono, 16 kHz, 16-bit
 *   - HID (vendor page) reporting button gestures and state, for WebHID
 *   - vendor-specific bulk interface for the link protocol (WebUSB, WinUSB)
 */
#pragma once

#ifndef CFG_TUSB_MCU
#error CFG_TUSB_MCU must be defined
#endif
#ifndef CFG_TUSB_OS
#define CFG_TUSB_OS OPT_OS_FREERTOS
#endif
#define CFG_TUSB_OS_INC_PATH freertos/
#ifndef CFG_TUSB_DEBUG
#define CFG_TUSB_DEBUG 0
#endif
#define CFG_TUSB_MEM_SECTION
#define CFG_TUSB_MEM_ALIGN __attribute__((aligned(4)))

#define CFG_TUD_ENABLED 1
#define CFG_TUD_MAX_SPEED BOARD_TUD_MAX_SPEED
#define CFG_TUD_ENDPOINT0_SIZE 64

#define CFG_TUD_AUDIO 1
#define CFG_TUD_HID 1
#define CFG_TUD_VENDOR 1
#define CFG_TUD_CDC 0
#define CFG_TUD_MSC 0
#define CFG_TUD_MIDI 0

/* Audio: one microphone function. */
#define CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE 16000
#define CFG_TUD_AUDIO_ENABLE_EP_IN 1
#define CFG_TUD_AUDIO_FUNC_1_N_BYTES_PER_SAMPLE_TX 2
#define CFG_TUD_AUDIO_FUNC_1_N_CHANNELS_TX 1
#define CFG_TUD_AUDIO_EP_SZ_IN                                                                   \
  TUD_AUDIO_EP_SIZE(TUD_OPT_HIGH_SPEED, CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE,                        \
                    CFG_TUD_AUDIO_FUNC_1_N_BYTES_PER_SAMPLE_TX, CFG_TUD_AUDIO_FUNC_1_N_CHANNELS_TX)
#define CFG_TUD_AUDIO_FUNC_1_EP_IN_SZ_MAX CFG_TUD_AUDIO_EP_SZ_IN
/* The microphone task writes 10 ms at a time: buffer 32 ms so the host never runs dry. */
#define CFG_TUD_AUDIO_FUNC_1_EP_IN_SW_BUF_SZ (32 * CFG_TUD_AUDIO_EP_SZ_IN)
#define CFG_TUD_AUDIO_FUNC_1_DESC_LEN TUD_AUDIO20_MIC_ONE_CH_DESC_LEN
#define CFG_TUD_AUDIO_FUNC_1_N_AS_INT 1
#define CFG_TUD_AUDIO_FUNC_1_CTRL_BUF_SZ 64

/* HID: 8-byte reports. */
#define CFG_TUD_HID_EP_BUFSIZE 16

/* Vendor: room for a whole link frame (4 KB payload + 12 bytes) in each direction. */
#define CFG_TUD_VENDOR_EPSIZE 64
#define CFG_TUD_VENDOR_RX_BUFSIZE 8192
#define CFG_TUD_VENDOR_TX_BUFSIZE 8192
