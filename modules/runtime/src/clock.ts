import { randomBytes } from "node:crypto";
export interface Clock { wall(): number; mono(): number; set(delayMs: number, callback: () => void): object; clear(handle: object): void }
export const systemClock: Clock = Object.freeze({ wall: () => Date.now(), mono: () => performance.now(), set: (delay: number, callback: () => void) => setTimeout(callback, delay), clear: (handle: object) => clearTimeout(handle as NodeJS.Timeout) });
export interface Entropy { bytes(length: number): Uint8Array }
export const systemEntropy: Entropy = Object.freeze({ bytes: (length: number) => randomBytes(length) });
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => T | Promise<T>): Promise<T> { let release!: () => void; const next = new Promise<void>((resolve) => { release = resolve; }); const previous = this.#tail; this.#tail = previous.then(() => next); await previous; try { return await operation(); } finally { release(); } }
}
export const sleep = (clock: Clock, delay: number): Promise<void> => new Promise((resolve) => { clock.set(delay, resolve); });
