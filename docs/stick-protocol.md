# Bibbly Stick link protocol (v1)

The byte protocol between the Bibbly Stick and the apps. The same frames travel over:

| Transport | Where | Notes |
|---|---|---|
| USB vendor interface (bulk OUT 0x03, IN 0x83) | Desktop app (WebUSB in Electron, Chrome, Edge) | Interface class 0xFF; Microsoft OS 2.0 descriptors make Windows bind WinUSB automatically; Linux needs the udev rule (`firmware/bibbly-stick/tools/70-bibbly-stick.rules`, installed by the .deb). |
| Bluetooth LE GATT | Phone app | Service `b1bb1e00-5e1c-4b1d-9a8e-7a51c0de0001`; write to `…0002`, notifications from `…0003`. Writes need an encrypted, bonded link. |
| stdin/stdout | `stick-sim` (host build of the firmware logic) | Used by the desktop app's simulator and the tests. |

Implementations: `packages/core/src/stick/protocol.ts` and `client.ts` (TypeScript, used by the apps) and `firmware/bibbly-stick/components/stick_core/` (C, used by the firmware and simulator). `packages/core/test/stick-sim.test.ts` runs the TypeScript client against the C implementation.

## Frames

```
"BB" | ver u8 | type u8 | code u8 | seq u8 | len u16 | payload (len bytes) | crc32 u32
```

- All integers are little-endian. `ver` is 1. `len` is at most 4096.
- `crc32` is the standard CRC-32 (IEEE 802.3, as in zlib) over `ver … payload`.
- `type`: 1 request (app → Stick), 2 response (same `code` and `seq` as the request), 3 event (Stick → app, unsolicited).
- Frames are a byte stream: transports may split or merge them. Receivers resynchronise on `"BB"` and drop frames with a bad version, length or CRC.
- Every response payload starts with a status byte: 0 ok, 1 bad request, 2 not found, 3 busy, 4 storage error, 5 unsupported.

## Requests

| Code | Name | Request payload | Response payload (after status) |
|---|---|---|---|
| 0x01 | Ping | – | uptime ms u32 |
| 0x02 | Info | – | protocol u16, hardware u16, firmware char[16] (NUL padded), serial u8[8], flash KB u32, caps u32 |
| 0x03 | Status | – | state u8, battery u8 (255 = none), charging u8, mode u8, free KB u32, total KB u32, recordings u16, mic level i16 (0.1 dBFS), recording ms u32, flags u8 |
| 0x04 | List | start u16, max u16 | total u16, count u8, then `count` × entry: id u16, size u32, start epoch ms u64, duration ms u32, flags u8 (bit 0 synced), reserved u8 |
| 0x05 | Read | id u16, offset u32, length u16 | id u16, offset u32, data (up to 4089 bytes) |
| 0x06 | Delete | id u16 | – (busy while that recording is in progress) |
| 0x07 | SetTime | epoch ms u64 | – |
| 0x08 | SetMode | mode u8 | mode u8 |
| 0x09 | Record | 1 start / 0 stop | state u8, id u16 |
| 0x0A | LedTest | pattern u8 (0 off, 1 rainbow, 2 RGB, 3 blink) | – |
| 0x0B | MarkSynced | id u16 | – |

`Status.flags` (a trailing byte; readers that stop early can ignore it): bit 0 muted, 1 clock set, 2 storage encrypted, 3 on USB, 4 no storage card.

`Info.caps`: bit 0 USB microphone, 1 HID, 2 Bluetooth LE, 3 encrypted storage, 4 battery.

States: 0 idle, 1 streaming (a computer is using the microphone), 2 recording, 3 syncing (shortly after a Read), 4 low battery, 5 error.
Modes (microphone tuning): 0 meeting mic, 1 pocket recorder, 2 room.

## Events

| Code | Name | Payload |
|---|---|---|
| 0x81 | Button | gesture u8: 1 short, 2 double, 3 long |
| 0x82 | State | state u8, recording id u16 (0 when not recording) |
| 0x83 | Battery | percent u8 (255 = none), charging u8 |

The HID interface mirrors events as 8-byte input reports (report ID 1): `code, payload[0..2], state, mode, battery, flags`, so pages using WebHID see the button without opening the sync interface.

## Recordings

Recordings are mono 16 kHz IMA ADPCM WAV files (format 0x0011, 512-byte blocks of 1017 samples) with a `fact` chunk (sample count) and a `bbly` chunk (flags u32 = 1, start epoch ms u64). The 80-byte header layout is fixed; `encodeWavIma()` in `packages/core/src/audio/wav.ts` produces byte-identical files, and the integration test checks this.

`Read` always returns the plain WAV. On the card each recording is encrypted with AES-256-CTR under a per-device key (`R<id>.BBY`: 32-byte header with magic `BBLYENC1` and a 12-byte random nonce, then the encrypted WAV; the counter block is nonce ‖ big-endian block index). A recording interrupted by a power cut is repaired at the next start (whole blocks are kept).

## Downloading a recording

`StickClient.read()` lists the recording, then reads it in 4080-byte chunks with `Read`, checking each response's id and offset. It marks the recording with `MarkSynced` after the app has saved it.
