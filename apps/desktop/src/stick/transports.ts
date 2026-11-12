import type { StickTransport } from '@bibbly/core';
import { api } from '../api';

export const STICK_USB = { vendorId: 0x1209, productId: 0x0001 };

/** The Stick's sync interface over WebUSB (vendor-specific bulk endpoints). */
export class WebUsbTransport implements StickTransport {
  private sinks = new Set<(b: Uint8Array) => void>();
  private open = true;
  private constructor(private readonly device: USBDevice, private readonly iface: number, private readonly epIn: number, private readonly epOut: number) {
    void this.readLoop();
  }

  /** Asks the user to pick a Bibbly Stick, then opens its sync interface. */
  static async request(): Promise<WebUsbTransport> {
    if (!('usb' in navigator)) throw new Error('This computer does not support WebUSB.');
    const device = await navigator.usb.requestDevice({ filters: [STICK_USB] });
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const iface = device.configuration?.interfaces.find(i => i.alternate.interfaceClass === 0xff);
    if (!iface) throw new Error('This device does not look like a Bibbly Stick (no sync interface).');
    await device.claimInterface(iface.interfaceNumber);
    const ep = (dir: USBDirection) => iface.alternate.endpoints.find(e => e.direction === dir && e.type === 'bulk')?.endpointNumber;
    const epIn = ep('in'), epOut = ep('out');
    if (epIn == null || epOut == null) throw new Error('The Stick’s sync interface is missing its endpoints.');
    return new WebUsbTransport(device, iface.interfaceNumber, epIn, epOut);
  }

  private async readLoop() {
    while (this.open) {
      try {
        const r = await this.device.transferIn(this.epIn, 4096);
        if (r.data && r.data.byteLength) {
          const bytes = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          this.sinks.forEach(cb => cb(bytes));
        }
      } catch {
        this.open = false;
      }
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.device.transferOut(this.epOut, bytes.slice());
  }

  onData(cb: (b: Uint8Array) => void): () => void { this.sinks.add(cb); return () => this.sinks.delete(cb); }

  async close(): Promise<void> {
    this.open = false;
    try { await this.device.releaseInterface(this.iface); await this.device.close(); } catch { /* already gone */ }
  }
}

/** The firmware logic running on this computer (development and tests). */
export class SimulatorTransport implements StickTransport {
  private unsub: () => void = () => {};
  static async start(): Promise<SimulatorTransport> {
    if (!(await api.stick.simulatorStart())) throw new Error('The Stick simulator is not built. Run "npm run firmware:test" first.');
    return new SimulatorTransport();
  }
  async write(bytes: Uint8Array): Promise<void> { api.stick.simulatorWrite(bytes); }
  onData(cb: (b: Uint8Array) => void): () => void { this.unsub = api.stick.onSimulatorData(b => cb(new Uint8Array(b))); return this.unsub; }
  async close(): Promise<void> { this.unsub(); await api.stick.simulatorStop(); }
}
