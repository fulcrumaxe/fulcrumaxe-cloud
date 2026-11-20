/**
 * Why a call to the guest agent failed. A closed set; the message never carries a byte the guest sent.
 * `lost` is a stream that ended any way but with its one `exit` frame, or one whose framing the guest broke; `unsupported` is a guest whose
 * agent does not advertise the op (an older image).
 */
export class AgentError extends Error {
  constructor(readonly code: "unreachable" | "bad_reply" | "refused" | "timeout" | "bad_request" | "lost" | "unsupported") {
    super(`the guest agent failed: ${code}`);
    this.name = "AgentError";
  }
}
