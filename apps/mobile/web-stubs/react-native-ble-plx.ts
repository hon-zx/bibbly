/** Web preview only: Bluetooth isn't available in the browser preview of the phone app. */
export class BleManager {
  startDeviceScan(_u: unknown, _o: unknown, cb: (e: Error | null, d: null) => void) { cb(new Error('Bluetooth needs the phone app.'), null); return Promise.resolve(); }
  stopDeviceScan() { return Promise.resolve(); }
  connectToDevice(): Promise<never> { return Promise.reject(new Error('Bluetooth needs the phone app.')); }
}
export type Device = never;
export type Subscription = { remove(): void };
