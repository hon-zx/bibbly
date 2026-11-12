# Bibbly Stick firmware (ESP32-S3)

The Stick is a USB-C microphone first and a pocket recorder second:

- **Plugged in**, it is a standard USB Audio Class 2.0 microphone (16 kHz mono), so it works on Windows, macOS, Linux, ChromeOS and USB-C phones without drivers, even on laptops that block USB storage. Bibbly for desktop talks to it over a vendor "sync" interface (WebUSB) to list, import and delete recordings, set the clock and change modes. A HID interface reports the button.
- **Unplugged**, a long press records to an encrypted microSD card. Recordings sync over USB the next time it's plugged in, or to the phone over Bluetooth LE.
- **Bibbly's eyes** (two RGB lights) show what it's doing, with an optional ring of lights around the button.

## Layout

```
components/stick_core/   portable C: link protocol, ADPCM/WAV recorder, encrypted store,
                         button gestures, light patterns, microphone DSP, device state machine
host/                    builds stick_core on a computer: 507 unit checks and stick-sim
main/                    ESP-IDF platform layer (USB, microphones, microSD, lights, BLE, power)
components/tinyusb_bibbly/  TinyUSB built with the Stick's configuration (tusb_config.h)
tools/70-bibbly-stick.rules  Linux udev rule for the sync interface
```

The device behaviour lives in `stick_core`, which has no ESP-IDF dependencies, so it is unit-tested and also runs as `stick-sim`. The desktop app uses `stick-sim` when no Stick is plugged in, and the TypeScript tests drive it to check that both sides of the protocol agree. The recorder is byte-identical to the app's WAV encoder.

## Test on a computer

```bash
npm run firmware:test        # from the repository root: configure, build, run unit tests and the simulator smoke test
```

Encryption is tested when mbedTLS is available: install `libmbedtls-dev`, or set `IDF_PATH` to an ESP-IDF checkout before configuring. Without either, the simulator stores plain WAV files and the encryption tests are skipped.

`stick-sim --demo-recordings` starts a simulated Stick with three recordings; signals stand in for the button (`SIGUSR1` long press, `SIGUSR2` short, `SIGHUP` double). `stick-sim --wav-from-pcm in.raw out.wav` runs the recorder on raw 16 kHz PCM.

## Build and flash

Needs ESP-IDF v5.5 and TinyUSB 0.21.0:

```bash
git submodule add https://github.com/hathach/tinyusb firmware/bibbly-stick/third_party/tinyusb
git -C firmware/bibbly-stick/third_party/tinyusb checkout 0.21.0
cd firmware/bibbly-stick
idf.py set-target esp32s3
idf.py menuconfig            # "Bibbly Stick": pins, ring lights, battery, Bluetooth
idf.py build flash monitor   # logs go to the UART pins; the USB port belongs to TinyUSB
```

(Or set `TINYUSB_PATH` to an existing TinyUSB 0.21.0 checkout.) `led_strip` comes from the ESP component registry (`main/idf_component.yml`). CI builds the firmware with Espressif's ESP-IDF action (`.github/workflows/firmware.yml`).

For production, layer `sdkconfig.defaults.release` (flash encryption, NVS encryption, secure boot v2). It burns eFuses irreversibly; rehearse the factory process on sample boards first.

## Reference hardware

| Part | Suggested | Default pins (menuconfig) |
|---|---|---|
| MCU | ESP32-S3-WROOM-1-N16 (16 MB flash), native USB on GPIO 19/20 | |
| Microphones | 2 × PDM MEMS (L/R on one data line), e.g. Knowles SPH0641 | CLK 42, DATA 41 |
| Storage | microSD socket, 4-bit SDMMC, FAT32 card (16–64 GB) | CLK 14, CMD 15, D0–D3 16, 17, 18, 21 |
| Lights | WS2812-2020: 2 eyes, then 0–24 ring LEDs | DATA 48 |
| Button | to GND, internal pull-up (RTC GPIO so it can wake the chip) | 0 |
| Battery | 1-cell LiPo, charger with a status pin (e.g. MCP73831), 1:2 divider to ADC1 | ADC 1, CHG 4 |
| USB power sense | VBUS through a divider | 2 |

The pin map is for a first prototype on an ESP32-S3 dev board. Check strapping pins and the module's PSRAM pins against your board before laying out a PCB.

USB IDs default to 0x1209/0x0001 (the pid.codes test pair). Get your own before shipping and update `CONFIG_BIBBLY_USB_VID/PID`, `apps/desktop/src/stick/transports.ts` and the udev rule.

## Behaviour

| Button | Does |
|---|---|
| Long press (1.2 s) | Start or stop recording; works from sleep (hold to wake and record) |
| Double press | Next mode: meeting mic → pocket recorder → room (microphone tuning) |
| Short press | Mute or unmute while a computer is using the microphone; otherwise flash the battery level |

| Eyes | Meaning |
|---|---|
| Breathing lagoon green | Plugged in, ready |
| Steady lagoon green | A computer is using the microphone (dim red when muted) |
| Red pulse (ring spinner) | Recording |
| Alternating blue | Syncing |
| Amber blink | Battery low (recording is saved and stopped at 5%) |
| Red double blink | Can't record: no card, card full or write error |
| White blinks | Mode changed (one blink per mode number) |

On battery and idle for 10 minutes (menuconfig), the Stick deep-sleeps until the button is pressed or USB power returns. The clock survives sleep; after a full power loss recordings show "Time not set" until the next sync sets it.

## Security notes

- Recordings are encrypted at rest with AES-256-CTR and a per-device key from the hardware RNG, kept in NVS. With the release config, flash and NVS encryption protect the key, so a card removed from the Stick is unreadable. CTR mode gives confidentiality, not tamper detection.
- Anyone holding the Stick can read recordings over USB (like a voice recorder). Bluetooth requires a bonded, encrypted link, but uses "Just Works" pairing (no display or keypad). Next steps: an app-held pairing token for the link, and accepting new Bluetooth bonds only after a button press.

## Not done yet

- Built and syntax-checked against the real ESP-IDF v5.5.6, TinyUSB 0.21.0, NimBLE and led_strip headers, but not yet compiled with the Xtensa toolchain or run on hardware. The CI workflow does the full build once TinyUSB is added.
- Beamforming and noise suppression (ESP-SR AFE) for a two-to-four-mic array; today the pair is summed with DC removal and automatic gain.
- Firmware updates over the sync link (OTA partitions are not set up yet).
- exFAT cards (64 GB and larger come formatted exFAT; reformat as FAT32 for now).
