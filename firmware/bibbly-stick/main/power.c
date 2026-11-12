/*
 * Power: the button, the LiPo battery gauge (a voltage divider into ADC1),
 * the charger's status pin, USB power sensing and deep sleep. A press of the
 * button or plugging into USB wakes the Stick; holding the button through
 * wake-up starts a recording (one-touch record).
 */
#include "bibbly.h"
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "esp_sleep.h"

static const char *TAG = "power";

#define PIN_BUTTON ((gpio_num_t)CONFIG_BIBBLY_PIN_BUTTON)

#if CONFIG_BIBBLY_BATTERY
static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_cali;
static adc_channel_t s_chan;
static int s_smoothed_mv;
#endif

void power_start(void) {
  const gpio_config_t button = {
      .pin_bit_mask = 1ULL << CONFIG_BIBBLY_PIN_BUTTON,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
  };
  gpio_config(&button);
#if CONFIG_BIBBLY_PIN_VBUS >= 0
  const gpio_config_t vbus = {.pin_bit_mask = 1ULL << CONFIG_BIBBLY_PIN_VBUS, .mode = GPIO_MODE_INPUT};
  gpio_config(&vbus);
#endif
#if CONFIG_BIBBLY_BATTERY
#if CONFIG_BIBBLY_PIN_CHG_STAT >= 0
  const gpio_config_t chg = {
      .pin_bit_mask = 1ULL << CONFIG_BIBBLY_PIN_CHG_STAT,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
  };
  gpio_config(&chg);
#endif
  adc_unit_t unit;
  if (adc_oneshot_io_to_channel(CONFIG_BIBBLY_PIN_BATT_ADC, &unit, &s_chan) != ESP_OK || unit != ADC_UNIT_1) {
    ESP_LOGE(TAG, "battery pin is not on ADC1");
    return;
  }
  const adc_oneshot_unit_init_cfg_t init = {.unit_id = ADC_UNIT_1};
  ESP_ERROR_CHECK(adc_oneshot_new_unit(&init, &s_adc));
  const adc_oneshot_chan_cfg_t chan = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
  ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc, s_chan, &chan));
  const adc_cali_curve_fitting_config_t cali = {
      .unit_id = ADC_UNIT_1, .chan = s_chan, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
  if (adc_cali_create_scheme_curve_fitting(&cali, &s_cali) != ESP_OK) s_cali = NULL;
#endif
}

bool power_button_pressed(void) { return gpio_get_level(PIN_BUTTON) == 0; }

bool power_woke_by_button(void) { return esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0; }

#if CONFIG_BIBBLY_BATTERY
/* Resting LiPo voltage to charge, from a typical single-cell discharge curve. */
static uint8_t lipo_percent(int mv) {
  static const int table[][2] = {{4180, 100}, {4100, 92}, {4000, 80}, {3900, 64}, {3800, 46},
                                 {3730, 30},  {3680, 18}, {3600, 8},  {3500, 3},  {3300, 0}};
  if (mv >= table[0][0]) return 100;
  for (size_t i = 1; i < sizeof(table) / sizeof(table[0]); i++) {
    if (mv >= table[i][0]) {
      const int span = table[i - 1][0] - table[i][0];
      return (uint8_t)(table[i][1] + (table[i - 1][1] - table[i][1]) * (mv - table[i][0]) / span);
    }
  }
  return 0;
}
#endif

void power_read(uint8_t *pct, bool *charging) {
  *pct = STICK_BATTERY_NONE;
  *charging = false;
#if CONFIG_BIBBLY_BATTERY
  if (!s_adc) return;
  int sum = 0, n = 0;
  for (int i = 0; i < 8; i++) {
    int raw = 0, mv = 0;
    if (adc_oneshot_read(s_adc, s_chan, &raw) != ESP_OK) continue;
    if (s_cali && adc_cali_raw_to_voltage(s_cali, raw, &mv) == ESP_OK) sum += mv;
    else sum += raw * 3100 / 4095;
    n++;
  }
  if (!n) return;
  const int mv = sum / n * CONFIG_BIBBLY_BATT_DIVIDER_X100 / 100;
  s_smoothed_mv = s_smoothed_mv ? (s_smoothed_mv * 7 + mv) / 8 : mv;
  *pct = lipo_percent(s_smoothed_mv);
#if CONFIG_BIBBLY_PIN_CHG_STAT >= 0
  *charging = gpio_get_level((gpio_num_t)CONFIG_BIBBLY_PIN_CHG_STAT) == 0;
#elif CONFIG_BIBBLY_PIN_VBUS >= 0
  *charging = gpio_get_level((gpio_num_t)CONFIG_BIBBLY_PIN_VBUS) == 1 && *pct < 100;
#endif
#endif
}

void power_sleep(void) {
  rtc_gpio_pullup_en(PIN_BUTTON);
  rtc_gpio_pulldown_dis(PIN_BUTTON);
  esp_sleep_enable_ext0_wakeup(PIN_BUTTON, 0);
#if CONFIG_BIBBLY_PIN_VBUS >= 0
  esp_sleep_enable_ext1_wakeup(1ULL << CONFIG_BIBBLY_PIN_VBUS, ESP_EXT1_WAKEUP_ANY_HIGH);
#endif
  esp_deep_sleep_start();
}
