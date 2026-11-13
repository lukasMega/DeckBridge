/** Output report in hidapi framing, including byte 0 report id.
 * Consumed synchronously; callers reuse buffers after each call. */
export type ReportSink = (report: Uint8Array) => void;
