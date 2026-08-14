export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface ChatMessageItem {
  kind: "chat";
  id: string;
  username: string;
  text: string;
  timestamp: number;
  own: boolean;
  grouped: boolean;
}

export interface SystemMessageItem {
  kind: "system";
  id: string;
  text: string;
  timestamp: number;
}

export type TimelineItem = ChatMessageItem | SystemMessageItem;
