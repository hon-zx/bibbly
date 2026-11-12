# TinyUSB (third_party/tinyusb, a git submodule at release 0.21.0) built
# as an ESP-IDF component with the Stick's configuration in include/tusb_config.h:
# a USB Audio 2.0 microphone, a HID button and a vendor (WebUSB) sync interface.
# TINYUSB_PATH (environment) can point at an existing TinyUSB 0.21.0 checkout instead.
if(DEFINED ENV{TINYUSB_PATH})
  set(tusb_src $ENV{TINYUSB_PATH}/src)
else()
  set(tusb_src ${CMAKE_CURRENT_LIST_DIR}/../../third_party/tinyusb/src)
endif()
if(NOT EXISTS ${tusb_src}/tusb.c)
  message(FATAL_ERROR "TinyUSB 0.21.0 is missing. From the repository root run:\n"
    "  git submodule add https://github.com/hathach/tinyusb firmware/bibbly-stick/third_party/tinyusb\n"
    "  git -C firmware/bibbly-stick/third_party/tinyusb checkout 0.21.0\n"
    "or set TINYUSB_PATH to a checkout of that release.")
endif()

idf_component_register(
  SRCS ${tusb_src}/tusb.c
       ${tusb_src}/common/tusb_fifo.c
       ${tusb_src}/device/usbd.c
       ${tusb_src}/class/audio/audio_device.c
       ${tusb_src}/class/hid/hid_device.c
       ${tusb_src}/class/vendor/vendor_device.c
       ${tusb_src}/portable/synopsys/dwc2/dcd_dwc2.c
       ${tusb_src}/portable/synopsys/dwc2/dwc2_common.c
  INCLUDE_DIRS ${tusb_src} include
  PRIV_REQUIRES esp_mm esp_hw_support)

target_compile_definitions(${COMPONENT_LIB} PUBLIC
  CFG_TUSB_MCU=OPT_MCU_ESP32S3
  CFG_TUSB_OS=OPT_OS_FREERTOS
  BOARD_TUD_RHPORT=0
  BOARD_TUD_MAX_SPEED=OPT_MODE_FULL_SPEED)
