idf_component_register(
  SRCS main.c usb.c mic.c storage.c leds.c ble.c power.c
  INCLUDE_DIRS .
  REQUIRES stick_core tinyusb_bibbly
  PRIV_REQUIRES esp_driver_i2s esp_driver_gpio esp_driver_sdmmc sdmmc fatfs vfs nvs_flash esp_adc esp_timer
                esp_hw_support esp_system esp_app_format spi_flash usb bt)
