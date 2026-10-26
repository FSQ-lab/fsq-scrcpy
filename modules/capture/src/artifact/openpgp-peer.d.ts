declare module "@openpgp/web-stream-tools" {
  export type WebStream<T> = ReadableStream<T>;
  export type NodeWebStream<T> = import("node:stream").Readable;
}
