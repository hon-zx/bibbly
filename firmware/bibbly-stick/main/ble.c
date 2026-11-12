/*
 * Bluetooth LE link to the phone app: the same link protocol as USB, carried
 * over one GATT service.
 *
 *   Service  b1bb1e00-5e1c-4b1d-9a8e-7a51c0de0001
 *   RX       ...0002  write / write without response (app -> Stick); needs an encrypted, bonded link
 *   TX       ...0003  notify (Stick -> app); frames are split to the negotiated MTU
 *
 * Frames are a byte stream, so either side may split them across writes and
 * notifications; the link parser reassembles them.
 */
#include <string.h>

#include "bibbly.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#if CONFIG_BIBBLY_BLE
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

void ble_store_config_init(void);

static const char *TAG = "ble";

/* b1bb1e00-5e1c-4b1d-9a8e-7a51c0de000N, little-endian */
#define BIBBLY_UUID(n) \
  BLE_UUID128_INIT(n, 0x00, 0xde, 0xc0, 0x51, 0x7a, 0x8e, 0x9a, 0x1d, 0x4b, 0x1c, 0x5e, 0x00, 0x1e, 0xbb, 0xb1)
static const ble_uuid128_t SVC_UUID = BIBBLY_UUID(0x01);
static const ble_uuid128_t RX_UUID = BIBBLY_UUID(0x02);
static const ble_uuid128_t TX_UUID = BIBBLY_UUID(0x03);

static StreamBufferHandle_t s_rx;
static uint16_t s_tx_handle;
static uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static volatile bool s_subscribed;
static uint8_t s_own_addr_type;
static char s_name[24];

static int on_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg) {
  (void)conn_handle;
  (void)attr_handle;
  (void)arg;
  if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
  uint8_t buf[512];
  uint16_t len = 0;
  if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len) != 0) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
  if (xStreamBufferSend(s_rx, buf, len, 0) != len) return BLE_ATT_ERR_PREPARE_QUEUE_FULL;
  app_notify(APP_EVT_BLE_RX);
  return 0;
}

static const struct ble_gatt_svc_def s_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &SVC_UUID.u,
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {
                    .uuid = &RX_UUID.u,
                    .access_cb = on_access,
                    .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_WRITE_ENC,
                },
                {
                    .uuid = &TX_UUID.u,
                    .access_cb = on_access,
                    .val_handle = &s_tx_handle,
                    .flags = BLE_GATT_CHR_F_NOTIFY,
                },
                {0},
            },
    },
    {0},
};

static int on_gap(struct ble_gap_event *event, void *arg);

static void advertise(void) {
  struct ble_hs_adv_fields fields = {0};
  fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
  fields.name = (const uint8_t *)s_name;
  fields.name_len = (uint8_t)strlen(s_name);
  fields.name_is_complete = 1;
  if (ble_gap_adv_set_fields(&fields) != 0) return;
  struct ble_hs_adv_fields rsp = {0};
  rsp.uuids128 = &SVC_UUID;
  rsp.num_uuids128 = 1;
  rsp.uuids128_is_complete = 1;
  ble_gap_adv_rsp_set_fields(&rsp);
  struct ble_gap_adv_params params = {0};
  params.conn_mode = BLE_GAP_CONN_MODE_UND;
  params.disc_mode = BLE_GAP_DISC_MODE_GEN;
  params.itvl_min = BLE_GAP_ADV_ITVL_MS(500); /* slow advertising: the Stick lives on a battery */
  params.itvl_max = BLE_GAP_ADV_ITVL_MS(700);
  int rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &params, on_gap, NULL);
  if (rc != 0 && rc != BLE_HS_EALREADY) ESP_LOGW(TAG, "advertising failed: %d", rc);
}

static int on_gap(struct ble_gap_event *event, void *arg) {
  (void)arg;
  switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
      if (event->connect.status == 0) {
        s_conn = event->connect.conn_handle;
        ble_gap_security_initiate(s_conn); /* pair (or resume the bond) before any data flows */
      } else {
        advertise();
      }
      break;
    case BLE_GAP_EVENT_DISCONNECT:
      s_conn = BLE_HS_CONN_HANDLE_NONE;
      s_subscribed = false;
      app_notify(APP_EVT_BLE);
      advertise();
      break;
    case BLE_GAP_EVENT_SUBSCRIBE:
      if (event->subscribe.attr_handle == s_tx_handle) {
        s_subscribed = event->subscribe.cur_notify;
        app_notify(APP_EVT_BLE);
      }
      break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
      advertise();
      break;
    case BLE_GAP_EVENT_REPEAT_PAIRING: {
      /* The phone forgot us: drop the old bond and pair again. */
      struct ble_gap_conn_desc desc;
      if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) ble_store_util_delete_peer(&desc.peer_id_addr);
      return BLE_GAP_REPEAT_PAIRING_RETRY;
    }
    default:
      break;
  }
  return 0;
}

static void on_sync(void) {
  ble_hs_util_ensure_addr(0);
  ble_hs_id_infer_auto(0, &s_own_addr_type);
  advertise();
}

static void on_reset(int reason) { ESP_LOGW(TAG, "host reset (%d)", reason); }

static void host_task(void *param) {
  (void)param;
  nimble_port_run();
  nimble_port_freertos_deinit();
}

void ble_start(const char *name) {
  snprintf(s_name, sizeof(s_name), "%s", name);
  s_rx = xStreamBufferCreate(8192, 1);
  if (nimble_port_init() != ESP_OK) {
    ESP_LOGE(TAG, "NimBLE failed to start");
    return;
  }
  ble_hs_cfg.sync_cb = on_sync;
  ble_hs_cfg.reset_cb = on_reset;
  ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
  ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;
  ble_hs_cfg.sm_bonding = 1;
  ble_hs_cfg.sm_sc = 1;
  ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_svc_gap_init();
  ble_svc_gatt_init();
  if (ble_gatts_count_cfg(s_services) != 0 || ble_gatts_add_svcs(s_services) != 0) {
    ESP_LOGE(TAG, "GATT service setup failed");
    return;
  }
  ble_svc_gap_device_name_set(s_name);
  ble_store_config_init();
  nimble_port_freertos_init(host_task);
}

bool ble_link_connected(void) { return s_conn != BLE_HS_CONN_HANDLE_NONE && s_subscribed; }

size_t ble_link_read(uint8_t *buf, size_t cap) { return s_rx ? xStreamBufferReceive(s_rx, buf, cap, 0) : 0; }

void ble_link_send(void *ctx, const uint8_t *bytes, size_t len) {
  (void)ctx;
  int retries = 0;
  while (len && ble_link_connected()) {
    const uint16_t mtu = ble_att_mtu(s_conn);
    const size_t chunk = mtu > 3 ? (size_t)(mtu - 3) : 20;
    const uint16_t n = (uint16_t)(len < chunk ? len : chunk);
    struct os_mbuf *om = ble_hs_mbuf_from_flat(bytes, n);
    const int rc = om ? ble_gatts_notify_custom(s_conn, s_tx_handle, om) : BLE_HS_ENOMEM;
    if (rc == 0) {
      bytes += n;
      len -= n;
      retries = 0;
    } else if (rc == BLE_HS_ENOMEM && ++retries < 250) {
      vTaskDelay(pdMS_TO_TICKS(2)); /* controller buffers full: wait for them to drain */
    } else {
      ESP_LOGW(TAG, "notify failed (%d); dropping %u bytes", rc, (unsigned)len);
      return;
    }
  }
}

#else /* Bluetooth disabled in menuconfig */

void ble_start(const char *name) { (void)name; }
bool ble_link_connected(void) { return false; }
size_t ble_link_read(uint8_t *buf, size_t cap) {
  (void)buf;
  (void)cap;
  return 0;
}
void ble_link_send(void *ctx, const uint8_t *bytes, size_t len) {
  (void)ctx;
  (void)bytes;
  (void)len;
}

#endif
