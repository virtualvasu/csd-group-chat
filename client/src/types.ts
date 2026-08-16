export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

// How much a message can be trusted. Only failed integrity checks are reported
// today; signature states join this union later and MessageTrustBadge renders
// whatever is in it.
export type TrustStatus = "failed";

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
  integrity?: TrustStatus;
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
  integrity?: TrustStatus;
}
