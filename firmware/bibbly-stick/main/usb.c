/*
 * The Stick on USB: a composite full-speed device with
 *   0-1  USB Audio Class 2.0 microphone (mono, 16 kHz, 16-bit) - no drivers anywhere
 *   2    HID, vendor page: button gestures and state, for WebHID pages
 *   3    vendor bulk interface for the link protocol: WebUSB in Chrome and Edge,
 *        WinUSB on Windows via Microsoft OS 2.0 descriptors, libusb elsewhere
 */
#include <stdatomic.h>
#include <string.h>

#include "bibbly.h"
#include "esp_log.h"
#include "esp_private/usb_phy.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tusb.h"

static const char *TAG = "usb";

enum { ITF_NUM_AUDIO_CONTROL = 0, ITF_NUM_AUDIO_STREAMING, ITF_NUM_HID, ITF_NUM_VENDOR, ITF_NUM_TOTAL };
enum { STR_LANG = 0, STR_MANUFACTURER, STR_PRODUCT, STR_SERIAL, STR_MIC, STR_BUTTON, STR_SYNC };
enum { VENDOR_REQUEST_WEBUSB = 1, VENDOR_REQUEST_MICROSOFT = 2 };

#define EP_AUDIO_IN 0x81
#define EP_HID_IN 0x82
#define EP_VENDOR_OUT 0x03
#define EP_VENDOR_IN 0x83

/* Audio entity ids used by TUD_AUDIO20_MIC_ONE_CH_DESCRIPTOR. */
#define UAC_INPUT_TERMINAL 0x01
#define UAC_FEATURE_UNIT 0x02
#define UAC_CLOCK 0x04

static char s_serial[17];
static atomic_bool s_streaming;
static atomic_bool s_host_mute;
static atomic_int s_volume_q8; /* host volume, 1/256 dB */

/* ---- Descriptors ------------------------------------------------------------- */

static const tusb_desc_device_t desc_device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0210, /* 2.1: has a BOS descriptor */
    .bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = CONFIG_BIBBLY_USB_VID,
    .idProduct = CONFIG_BIBBLY_USB_PID,
    .bcdDevice = 0x0100,
    .iManufacturer = STR_MANUFACTURER,
    .iProduct = STR_PRODUCT,
    .iSerialNumber = STR_SERIAL,
    .bNumConfigurations = 1,
};

static const uint8_t desc_hid_report[] = {TUD_HID_REPORT_DESC_GENERIC_INOUT(8, HID_REPORT_ID(1))};

#define CONFIG_TOTAL_LEN \
  (TUD_CONFIG_DESC_LEN + TUD_AUDIO20_MIC_ONE_CH_DESC_LEN + TUD_HID_DESC_LEN + TUD_VENDOR_DESC_LEN)

static const uint8_t desc_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN, 0x00, 100),
    TUD_AUDIO20_MIC_ONE_CH_DESCRIPTOR(ITF_NUM_AUDIO_CONTROL, STR_MIC, CFG_TUD_AUDIO_FUNC_1_N_BYTES_PER_SAMPLE_TX,
                                      CFG_TUD_AUDIO_FUNC_1_N_BYTES_PER_SAMPLE_TX * 8, EP_AUDIO_IN,
                                      CFG_TUD_AUDIO_EP_SZ_IN),
    TUD_HID_DESCRIPTOR(ITF_NUM_HID, STR_BUTTON, HID_ITF_PROTOCOL_NONE, sizeof(desc_hid_report), EP_HID_IN,
                       CFG_TUD_HID_EP_BUFSIZE, 10),
    TUD_VENDOR_DESCRIPTOR(ITF_NUM_VENDOR, STR_SYNC, EP_VENDOR_OUT, EP_VENDOR_IN, 64),
};

#define BOS_TOTAL_LEN (TUD_BOS_DESC_LEN + TUD_BOS_WEBUSB_DESC_LEN + TUD_BOS_MICROSOFT_OS_DESC_LEN)
#define MS_OS_20_DESC_LEN 0xB2

static const uint8_t desc_bos[] = {
    TUD_BOS_DESCRIPTOR(BOS_TOTAL_LEN, 2),
    TUD_BOS_WEBUSB_DESCRIPTOR(VENDOR_REQUEST_WEBUSB, 0), /* no landing page */
    TUD_BOS_MS_OS_20_DESCRIPTOR(MS_OS_20_DESC_LEN, VENDOR_REQUEST_MICROSOFT),
};

/* Tells Windows to bind WinUSB to the sync interface, so Chrome can open it without an installer. */
static const uint8_t desc_ms_os_20[] = {
    U16_TO_U8S_LE(0x000A), U16_TO_U8S_LE(MS_OS_20_SET_HEADER_DESCRIPTOR), U32_TO_U8S_LE(0x06030000),
    U16_TO_U8S_LE(MS_OS_20_DESC_LEN),
    U16_TO_U8S_LE(0x0008), U16_TO_U8S_LE(MS_OS_20_SUBSET_HEADER_CONFIGURATION), 0, 0,
    U16_TO_U8S_LE(MS_OS_20_DESC_LEN - 0x0A),
    U16_TO_U8S_LE(0x0008), U16_TO_U8S_LE(MS_OS_20_SUBSET_HEADER_FUNCTION), ITF_NUM_VENDOR, 0,
    U16_TO_U8S_LE(MS_OS_20_DESC_LEN - 0x0A - 0x08),
    U16_TO_U8S_LE(0x0014), U16_TO_U8S_LE(MS_OS_20_FEATURE_COMPATBLE_ID), 'W', 'I', 'N', 'U', 'S', 'B', 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    U16_TO_U8S_LE(MS_OS_20_DESC_LEN - 0x0A - 0x08 - 0x08 - 0x14), U16_TO_U8S_LE(MS_OS_20_FEATURE_REG_PROPERTY),
    U16_TO_U8S_LE(0x0007), U16_TO_U8S_LE(0x002A), /* REG_MULTI_SZ, "DeviceInterfaceGUIDs" */
    'D', 0, 'e', 0, 'v', 0, 'i', 0, 'c', 0, 'e', 0, 'I', 0, 'n', 0, 't', 0, 'e', 0, 'r', 0, 'f', 0, 'a', 0, 'c', 0,
    'e', 0, 'G', 0, 'U', 0, 'I', 0, 'D', 0, 's', 0, 0, 0,
    U16_TO_U8S_LE(0x0050), /* "{38E30C56-7F50-4348-BA84-8C6C6C61D439}" */
    '{', 0, '3', 0, '8', 0, 'E', 0, '3', 0, '0', 0, 'C', 0, '5', 0, '6', 0, '-', 0, '7', 0, 'F', 0, '5', 0, '0', 0,
    '-', 0, '4', 0, '3', 0, '4', 0, '8', 0, '-', 0, 'B', 0, 'A', 0, '8', 0, '4', 0, '-', 0, '8', 0, 'C', 0, '6', 0,
    'C', 0, '6', 0, 'C', 0, '6', 0, '1', 0, 'D', 0, '4', 0, '3', 0, '9', 0, '}', 0, 0, 0, 0, 0,
};
TU_VERIFY_STATIC(sizeof(desc_ms_os_20) == MS_OS_20_DESC_LEN, "MS OS 2.0 descriptor length");

static const char *const strings[] = {
    [STR_MANUFACTURER] = "Bibbly",
    [STR_PRODUCT] = "Bibbly Stick",
    [STR_SERIAL] = s_serial,
    [STR_MIC] = "Bibbly Stick Microphone",
    [STR_BUTTON] = "Bibbly Stick Button",
    [STR_SYNC] = "Bibbly Stick Sync",
};

const uint8_t *tud_descriptor_device_cb(void) { return (const uint8_t *)&desc_device; }

const uint8_t *tud_descriptor_configuration_cb(uint8_t index) {
  (void)index;
  return desc_configuration;
}

const uint8_t *tud_descriptor_bos_cb(void) { return desc_bos; }

const uint8_t *tud_hid_descriptor_report_cb(uint8_t instance) {
  (void)instance;
  return desc_hid_report;
}

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
  (void)langid;
  static uint16_t out[33];
  size_t count;
  if (index == STR_LANG) {
    out[1] = 0x0409;
    count = 1;
  } else {
    if (index >= sizeof(strings) / sizeof(strings[0]) || !strings[index]) return NULL;
    const char *s = strings[index];
    count = strlen(s);
    if (count > 32) count = 32;
    for (size_t i = 0; i < count; i++) out[1 + i] = (uint8_t)s[i];
  }
  out[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * count + 2));
  return out;
}

/* ---- Device state ------------------------------------------------------------ */

void tud_mount_cb(void) { app_notify(APP_EVT_USB); }

void tud_umount_cb(void) {
  atomic_store(&s_streaming, false);
  app_notify(APP_EVT_USB);
}

void tud_suspend_cb(bool remote_wakeup_en) {
  (void)remote_wakeup_en;
  atomic_store(&s_streaming, false);
  app_notify(APP_EVT_USB);
}

void tud_resume_cb(void) { app_notify(APP_EVT_USB); }

bool usb_mounted(void) { return tud_mounted() && !tud_suspended(); }
bool usb_streaming(void) { return atomic_load(&s_streaming); }
bool usb_host_muted(void) { return atomic_load(&s_host_mute); }
float usb_host_volume_db(void) { return (float)atomic_load(&s_volume_q8) / 256.0f; }

/* ---- Microphone (UAC2) ------------------------------------------------------- */

void usb_mic_write(const int16_t *pcm, size_t samples) {
  if (atomic_load(&s_streaming)) tud_audio_write(pcm, (uint16_t)(samples * sizeof(int16_t)));
}

bool tud_audio_set_itf_cb(uint8_t rhport, const tusb_control_request_t *p_request) {
  (void)rhport;
  const uint8_t itf = tu_u16_low(p_request->wIndex);
  const uint8_t alt = tu_u16_low(p_request->wValue);
  if (itf == ITF_NUM_AUDIO_STREAMING) {
    atomic_store(&s_streaming, alt != 0);
    app_notify(APP_EVT_USB);
  }
  return true;
}

bool tud_audio_set_itf_close_ep_cb(uint8_t rhport, const tusb_control_request_t *p_request) {
  (void)rhport;
  if (tu_u16_low(p_request->wIndex) == ITF_NUM_AUDIO_STREAMING) {
    atomic_store(&s_streaming, false);
    app_notify(APP_EVT_USB);
  }
  return true;
}

bool tud_audio_set_req_entity_cb(uint8_t rhport, const tusb_control_request_t *p_request, uint8_t *buf) {
  (void)rhport;
  const uint8_t ctrl = tu_u16_high(p_request->wValue);
  const uint8_t entity = tu_u16_high(p_request->wIndex);
  if (p_request->bRequest != AUDIO20_CS_REQ_CUR || entity != UAC_FEATURE_UNIT) return false;
  if (ctrl == AUDIO20_FU_CTRL_MUTE && p_request->wLength == sizeof(audio20_control_cur_1_t)) {
    atomic_store(&s_host_mute, ((audio20_control_cur_1_t *)buf)->bCur != 0);
    return true;
  }
  if (ctrl == AUDIO20_FU_CTRL_VOLUME && p_request->wLength == sizeof(audio20_control_cur_2_t)) {
    atomic_store(&s_volume_q8, (int16_t)((audio20_control_cur_2_t *)buf)->bCur);
    return true;
  }
  return false;
}

bool tud_audio_get_req_entity_cb(uint8_t rhport, const tusb_control_request_t *p_request) {
  const uint8_t ctrl = tu_u16_high(p_request->wValue);
  const uint8_t entity = tu_u16_high(p_request->wIndex);
  if (entity == UAC_CLOCK) {
    if (ctrl == AUDIO20_CS_CTRL_SAM_FREQ && p_request->bRequest == AUDIO20_CS_REQ_CUR) {
      uint32_t rate = CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE;
      return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &rate, sizeof(rate));
    }
    if (ctrl == AUDIO20_CS_CTRL_SAM_FREQ && p_request->bRequest == AUDIO20_CS_REQ_RANGE) {
      audio20_control_range_4_n_t(1) range = {.wNumSubRanges = 1};
      range.subrange[0].bMin = CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE;
      range.subrange[0].bMax = CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE;
      range.subrange[0].bRes = 0;
      return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &range, sizeof(range));
    }
    if (ctrl == AUDIO20_CS_CTRL_CLK_VALID) {
      uint8_t valid = 1;
      return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &valid, sizeof(valid));
    }
  } else if (entity == UAC_INPUT_TERMINAL && ctrl == AUDIO20_TE_CTRL_CONNECTOR) {
    audio20_desc_channel_cluster_t cluster = {.bNrChannels = 1, .bmChannelConfig = (audio20_channel_config_t)0,
                                              .iChannelNames = 0};
    return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &cluster, sizeof(cluster));
  } else if (entity == UAC_FEATURE_UNIT) {
    if (ctrl == AUDIO20_FU_CTRL_MUTE) {
      uint8_t mute = atomic_load(&s_host_mute) ? 1 : 0;
      return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &mute, sizeof(mute));
    }
    if (ctrl == AUDIO20_FU_CTRL_VOLUME && p_request->bRequest == AUDIO20_CS_REQ_CUR) {
      int16_t vol = (int16_t)atomic_load(&s_volume_q8);
      return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &vol, sizeof(vol));
    }
    if (ctrl == AUDIO20_FU_CTRL_VOLUME && p_request->bRequest == AUDIO20_CS_REQ_RANGE) {
      audio20_control_range_2_n_t(1) range = {.wNumSubRanges = 1};
      range.subrange[0].bMin = -40 * 256; /* -40 dB */
      range.subrange[0].bMax = 20 * 256;  /* +20 dB */
      range.subrange[0].bRes = 256;       /* 1 dB steps */
      return tud_audio_buffer_and_schedule_control_xfer(rhport, p_request, &range, sizeof(range));
    }
  }
  return false;
}

/* ---- HID --------------------------------------------------------------------- */

void usb_hid_report(const uint8_t report[8]) {
  if (usb_mounted() && tud_hid_ready()) tud_hid_report(1, report, 8);
}

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer,
                               uint16_t reqlen) {
  (void)instance;
  (void)report_id;
  (void)report_type;
  (void)buffer;
  (void)reqlen;
  return 0;
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id, hid_report_type_t report_type, const uint8_t *buffer,
                           uint16_t bufsize) {
  /* Output reports are reserved for future use (the link protocol carries commands). */
  (void)instance;
  (void)report_id;
  (void)report_type;
  (void)buffer;
  (void)bufsize;
}

/* ---- Sync interface (vendor bulk) ------------------------------------------- */

bool tud_vendor_control_xfer_cb(uint8_t rhport, uint8_t stage, const tusb_control_request_t *request) {
  if (stage != CONTROL_STAGE_SETUP) return true;
  if (request->bmRequestType_bit.type == TUSB_REQ_TYPE_VENDOR && request->bRequest == VENDOR_REQUEST_MICROSOFT &&
      request->wIndex == 7) {
    return tud_control_xfer(rhport, request, (void *)(uintptr_t)desc_ms_os_20, MS_OS_20_DESC_LEN);
  }
  return false; /* no WebUSB landing page */
}

void tud_vendor_rx_cb(uint8_t idx, const uint8_t *buffer, uint32_t bufsize) {
  (void)idx;
  (void)buffer;
  (void)bufsize;
  app_notify(APP_EVT_USB_RX);
}

size_t usb_link_read(uint8_t *buf, size_t cap) {
  if (!tud_mounted() || !tud_vendor_n_available(0)) return 0;
  return tud_vendor_n_read(0, buf, (uint32_t)cap);
}

void usb_link_send(void *ctx, const uint8_t *bytes, size_t len) {
  (void)ctx;
  int stalled = 0;
  while (len && tud_mounted()) {
    const uint32_t n = tud_vendor_n_write(0, bytes, (uint32_t)len);
    tud_vendor_n_write_flush(0);
    bytes += n;
    len -= n;
    if (len) {
      if (n == 0 && ++stalled > 500) {
        ESP_LOGW(TAG, "host stopped reading the sync interface; dropping %u bytes", (unsigned)len);
        return;
      }
      vTaskDelay(1);
    }
  }
}

/* ---- Start-up ---------------------------------------------------------------- */

static void usb_task(void *arg) {
  (void)arg;
  const tusb_rhport_init_t init = {.role = TUSB_ROLE_DEVICE, .speed = TUSB_SPEED_AUTO};
  if (!tusb_init(BOARD_TUD_RHPORT, &init)) {
    ESP_LOGE(TAG, "TinyUSB failed to start");
    vTaskDelete(NULL);
  }
  for (;;) tud_task();
}

void usb_start(const char *serial_hex) {
  snprintf(s_serial, sizeof(s_serial), "%s", serial_hex);
  static usb_phy_handle_t phy;
  const usb_phy_config_t phy_conf = {
      .controller = USB_PHY_CTRL_OTG,
      .target = USB_PHY_TARGET_INT,
      .otg_mode = USB_OTG_MODE_DEVICE,
      .otg_speed = USB_PHY_SPEED_UNDEFINED, /* let the host decide; avoids a known macOS race */
  };
  if (usb_new_phy(&phy_conf, &phy) != ESP_OK) {
    ESP_LOGE(TAG, "USB PHY init failed");
    return;
  }
  xTaskCreatePinnedToCore(usb_task, "usbd", 4096, NULL, configMAX_PRIORITIES - 2, NULL, 0);
}
