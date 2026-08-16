export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** The three possible signature verdicts the server emits. */
export type SignatureStatus = "valid" | "invalid" | "unsigned";

export interface ChatMessageItem {
  kind: "chat";
  id: string;
  username: string;
  text: string;
  timestamp: number;
  own: boolean;
  grouped: boolean;
  /** ECDSA signature verdict from the server. */
  signature: SignatureStatus;
  /** base64 SPKI public key of the sender, or null for unsigned messages. */
  senderPublicKey: string | null;
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
  text: string;
  timestamp: number;
  /** ECDSA signature verdict. */
  signature: SignatureStatus;
  /** base64 SPKI public key, or null for unsigned messages. */
  senderPublicKey: string | null;
}
