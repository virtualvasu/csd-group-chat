import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ConnectionStatus,
  ServerMessage,
  StoredItem,
  TimelineItem,
} from "@/types";
import { getOrCreateIdentity, exportPublicKey, sign } from "@/lib/identity";
import { buildCanonicalBytes } from "@/lib/canonical";

const TYPING_IDLE_MS = 2000;
let seq = 0;
const nextId = () => `${Date.now()}-${seq++}`;

// Works out which messages should sit tight under the one above them: a
// message is grouped when the item before it is a message from the same
// person. Doing this here rather than when a message arrives means the flags
// stay right no matter what order things were added in.
function buildTimeline(items: StoredItem[]): TimelineItem[] {
  return items.map((item, index) => {
    if (item.kind === "system") return item;

    const previous = items[index - 1];
    const grouped =
      previous?.kind === "chat" && previous.username === item.username;

    return { ...item, grouped };
  });
}

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
  const [items, setItems] = useState<StoredItem[]>([]);

  const timeline = useMemo(() => buildTimeline(items), [items]);

  const pushSystem = useCallback((text: string, timestamp = Date.now()) => {
    setItems((prev) => [
      ...prev,
      { kind: "system", id: nextId(), text, timestamp },
    ]);
  }, []);

  useEffect(() => {
    const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    socketRef.current = socket;

    // Start loading the identity eagerly so it is ready by the time the user
    // clicks "Join". Errors here are non-fatal — the join will still work but
    // messages will be sent unsigned.
    getOrCreateIdentity().catch(() => {});

    async function emitJoin(name: string) {
      let publicKey: string | null = null;
      try {
        publicKey = await exportPublicKey();
      } catch {
        // Identity unavailable: fall back to unsigned join (server allows it).
      }
      socket.emit("join", publicKey ? { username: name, publicKey } : name);
    }

    function scheduleReconnectJoin() {
      if (!hasJoinedRef.current || !usernameRef.current) return;
      setTimeout(() => {
        if (socket.connected && hasJoinedRef.current && usernameRef.current) {
          emitJoin(usernameRef.current);
        }
      }, 250);
    }

    function toChatItem(message: ServerMessage): StoredItem {
      return {
        kind: "chat",
        id: message.id,
        username: message.username,
        text: message.text,
        timestamp: message.timestamp,
        own: message.username === usernameRef.current,
        signature: message.signature ?? "unsigned",
        senderPublicKey: message.senderPublicKey ?? null,
        integrity: message.integrity,
      };
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

    // Earlier messages, sent to us right after we join.
    //
    // This arrives again after every reconnect, because reconnecting re-sends
    // the join. So only add messages we do not already have, otherwise one
    // short network drop would show the whole conversation twice. Anything
    // that was sent while we were offline is new to us and does get added.
    socket.on("chat-history", (history: ServerMessage[]) => {
      if (!Array.isArray(history) || history.length === 0) return;

      setItems((prev) => {
        const known = new Set(
          prev.filter((item) => item.kind === "chat").map((item) => item.id)
        );
        const missing = history
          .filter((message) => !known.has(message.id))
          .map(toChatItem);

        return missing.length === 0 ? prev : [...prev, ...missing];
      });
    });

    socket.on("chat-message", (message: ServerMessage) => {
      setTypingUsers((prev) => prev.filter((u) => u !== message.username));
      setItems((prev) => {
        // The sender already has this one if the history arrived first, so
        // check before adding it a second time.
        if (prev.some((item) => item.kind === "chat" && item.id === message.id)) {
          return prev;
        }

        return [...prev, toChatItem(message)];
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
    // Emit the keyed join payload; the effect's emitJoin is not in scope here
    // so we re-do the logic inline.
    exportPublicKey()
      .then((publicKey) => {
        socketRef.current?.emit("join", { username: trimmed, publicKey });
      })
      .catch(() => {
        // Fall back to bare string if identity is unavailable.
        socketRef.current?.emit("join", trimmed);
      });
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
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      setTyping(false);

      const timestamp = Date.now();

      let signature: string | null = null;
      try {
        const canonical = buildCanonicalBytes(usernameRef.current, timestamp, trimmed);
        signature = await sign(canonical);
      } catch {
        // Sign failed: send unsigned (server will mark it 'unsigned').
      }

      if (signature) {
        socketRef.current?.emit("chat-message", { text: trimmed, timestamp, signature });
      } else {
        socketRef.current?.emit("chat-message", trimmed);
      }
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
