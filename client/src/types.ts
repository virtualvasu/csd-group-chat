export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// How much a message can be trusted. Two separate questions are answered per
// message, and they are kept apart because they can disagree: a message can
// decrypt perfectly and still carry a signature from the wrong key.

// Whether the stored copy still matches its authentication tag. Only the
// failure is reported — a message that is fine carries no integrity field.
export type IntegrityStatus = "failed";

// Whether the sender's ECDSA signature verifies over the message text.
// "unsigned" means none was supplied, which is what messages from before
// signing existed look like. "unknown" means the message did not decrypt, so
// there is no plaintext left to check a signature against.
export type SignatureStatus = "valid" | "invalid" | "unsigned" | "unknown";

// What MessageTrustBadge can render. Either verdict can be handed to it.
export type TrustStatus = SignatureStatus | IntegrityStatus;

// The message exactly as the database holds it, base64-encoded. Shown in the
// encrypted view and the inspector, so that "messages are not stored as
// plaintext" is something a reader can check rather than take on trust.
export interface StoredForm {
  ciphertext: string | null;
  nonce: string | null;
  signature: string | null;
  clientTimestamp: number | null;
}

export interface ChatMessageItem {
  kind: "chat";
  id: string;
  username: string;
  // Null when the server could not recover the text, which happens when the
  // stored message failed its integrity check.
  text: string | null;
  timestamp: number;
  own: boolean;
  grouped: boolean;
  /** ECDSA signature verdict from the server. */
  signature: SignatureStatus;
  /** base64 SPKI public key of the sender, or null for unsigned messages. */
  senderPublicKey: string | null;
  /** Present only when the stored copy failed its integrity check. */
  integrity?: IntegrityStatus;
  /** The stored database record behind this message. */
  stored: StoredForm | null;
  /** True when this arrived in the history replay rather than live. */
  fromHistory: boolean;
}

export interface SystemMessageItem {
  kind: "system";
  id: string;
  text: string;
  timestamp: number;
}

export type TimelineItem = ChatMessageItem | SystemMessageItem;

// What we actually keep in state. The "grouped" flag is left out here because
// it depends on which item comes before it in the list, so it is worked out
// when the timeline is built instead of when a message arrives.
export type StoredItem = Omit<ChatMessageItem, "grouped"> | SystemMessageItem;

// A message as the server sends it, both for live messages and for history.
export interface ServerMessage {
  id: string;
  username: string;
  text: string | null;
  timestamp: number;
  /** ECDSA signature verdict. */
  signature: SignatureStatus;
  /** base64 SPKI public key, or null for unsigned messages. */
  senderPublicKey: string | null;
  /** Present only when the stored copy failed its integrity check. */
  integrity?: IntegrityStatus;
  /** The stored database record behind this message. */
  stored?: StoredForm;
}
