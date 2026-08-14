import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ConnectionStatus, TimelineItem } from "@/types";

const TYPING_IDLE_MS = 2000;
let seq = 0;
const nextId = () => `${Date.now()}-${seq++}`;

export function useChatSocket() {
  const socketRef = useRef<Socket | null>(null);
  const usernameRef = useRef("");
  const hasJoinedRef = useRef(false);
  const isTypingRef = useRef(false);
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [username, setUsername] = useState("");
  const [hasJoined, setHasJoined] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connected");
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);

  const pushSystem = useCallback((text: string, timestamp = Date.now()) => {
    setTimeline((prev) => [
      ...prev,
      { kind: "system", id: nextId(), text, timestamp },
    ]);
  }, []);

  useEffect(() => {
    const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    socketRef.current = socket;

    function scheduleReconnectJoin() {
      if (!hasJoinedRef.current || !usernameRef.current) return;
      setTimeout(() => {
        if (socket.connected && hasJoinedRef.current && usernameRef.current) {
          socket.emit("join", usernameRef.current);
        }
      }, 250);
    }

    socket.on("connect", () => {
      setConnectionStatus("connected");
      scheduleReconnectJoin();
    });

    socket.on("disconnect", () => {
      setConnectionStatus("disconnected");
      isTypingRef.current = false;
      setTypingUsers([]);
      pushSystem("Disconnected from server. Trying to reconnect...");
    });

    socket.io.on("reconnect_attempt", () => setConnectionStatus("reconnecting"));
    socket.io.on("reconnect", () => {
      setConnectionStatus("connected");
      scheduleReconnectJoin();
    });

    socket.on("join-success", ({ username: confirmed }) => {
      usernameRef.current = confirmed;
      setUsername(confirmed);
      if (!hasJoinedRef.current) {
        hasJoinedRef.current = true;
        setHasJoined(true);
      } else {
        pushSystem("Reconnected to the chat.");
      }
    });

    socket.on("join-error", ({ message }) => {
      if (!hasJoinedRef.current) {
        setJoinError(message);
      } else {
        pushSystem(`Reconnect failed: ${message}`);
      }
    });

    socket.on("message-error", ({ message }) => {
      pushSystem(`Message not sent: ${message}`);
    });

    socket.on("server-error", ({ message }) => {
      pushSystem(`Error: ${message}`);
    });

    socket.on("user-joined", ({ username: joined, timestamp }) => {
      pushSystem(`${joined} joined the chat`, timestamp);
    });

    socket.on("user-left", ({ username: left, timestamp }) => {
      setTypingUsers((prev) => prev.filter((u) => u !== left));
      pushSystem(`${left} left the chat`, timestamp);
    });

    socket.on("online-users", (users: string[]) => setOnlineUsers(users));

    socket.on("user-typing", ({ username: from, isTyping }) => {
      setTypingUsers((prev) => {
        if (isTyping) return prev.includes(from) ? prev : [...prev, from];
        return prev.filter((u) => u !== from);
      });
    });

    socket.on("chat-message", (message) => {
      setTypingUsers((prev) => prev.filter((u) => u !== message.username));
      setTimeline((prev) => {
        const last = prev[prev.length - 1];
        const grouped =
          last?.kind === "chat" && last.username === message.username;
        return [
          ...prev,
          {
            kind: "chat",
            id: nextId(),
            username: message.username,
            text: message.text,
            timestamp: message.timestamp,
            own: message.username === usernameRef.current,
            grouped,
          },
        ];
      });
    });

    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setJoinError("");
    socketRef.current?.emit("join", trimmed);
  }, []);

  const setTyping = useCallback((typing: boolean) => {
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    if (typing) {
      typingIdleTimer.current = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
    }
    if (typing === isTypingRef.current) return;
    isTypingRef.current = typing;
    socketRef.current?.emit("typing", typing);
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      socketRef.current?.emit("chat-message", trimmed);
      setTyping(false);
    },
    [setTyping]
  );

  return {
    username,
    hasJoined,
    joinError,
    connectionStatus,
    onlineUsers,
    typingUsers,
    timeline,
    join,
    sendMessage,
    setTyping,
  };
}
