import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type {
  ConnectionStatus,
  ServerMessage,
  StoredItem,
  TimelineItem,
} from "@/types";
import {
  exportPublicKey,
  sign,
  isSigningAvailable,
  decodeBase64,
} from "@/lib/identity";
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
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [historyCount, setHistoryCount] = useState(0);

  // Checked once: it depends on how the page was served, not on anything that
  // changes while it is open.
  const [signingAvailable] = useState(isSigningAvailable);

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
    // clicks "Join", and surface the public key so the UI can show which
    // identity this browser is about to log in as.
    if (signingAvailable) {
      exportPublicKey()
        .then(setPublicKey)
        .catch(() => {});
    }

    // Step one of the login: name the account and present the public key. The
    // server answers with a challenge rather than letting us straight in,
    // because a public key is not a secret.
    async function startAuth(name: string) {
      const key = await exportPublicKey();
      socket.emit("auth-start", { username: name, publicKey: key });
    }

    function scheduleReconnectAuth() {
      if (!hasJoinedRef.current || !usernameRef.current) return;
      setTimeout(() => {
        if (socket.connected && hasJoinedRef.current && usernameRef.current) {
          startAuth(usernameRef.current).catch(() => {});
        }
      }, 250);
    }

    function toChatItem(message: ServerMessage, fromHistory: boolean): StoredItem {
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
        stored: message.stored ?? null,
        fromHistory,
      };
    }

    // Step two: prove we hold the private key by signing the challenge bytes.
    socket.on("auth-challenge", ({ challenge }: { challenge: string }) => {
      sign(decodeBase64(challenge))
        .then((signature) => socket.emit("auth-response", { signature }))
        .catch(() => {
          setJoinError(
            "This browser could not sign the login challenge. Open the app over HTTPS or on localhost."
          );
        });
    });

    socket.on("connect", () => {
      setConnectionStatus("connected");
      scheduleReconnectAuth();
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
      scheduleReconnectAuth();
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

      setHistoryCount(history.length);
      setItems((prev) => {
        const known = new Set(
          prev.filter((item) => item.kind === "chat").map((item) => item.id)
        );
        const missing = history
          .filter((message) => !known.has(message.id))
          .map((message) => toChatItem(message, true));

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

        return [...prev, toChatItem(message, false)];
      });
    });

    return () => {
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kicks off the login. The rest of the handshake — challenge in, signature
  // out — is handled by the socket listeners set up above.
  const join = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setJoinError("");

    if (!isSigningAvailable()) {
      setJoinError(
        "This page cannot create a signing key. Open the app over HTTPS or on localhost."
      );
      return;
    }

    exportPublicKey()
      .then((key) => {
        socketRef.current?.emit("auth-start", { username: trimmed, publicKey: key });
      })
      .catch(() => {
        setJoinError("Could not load this browser's signing key. Try reloading the page.");
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

      // Sending unsigned is not an option any more — the server would refuse
      // it — so a signing failure is reported here rather than swallowed.
      try {
        const canonical = buildCanonicalBytes(usernameRef.current, timestamp, trimmed);
        const signature = await sign(canonical);

        socketRef.current?.emit("chat-message", { text: trimmed, timestamp, signature });
      } catch {
        pushSystem("Message not sent: this browser could not sign it.");
      }
    },
    [setTyping, pushSystem]
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
    /** This browser's base64 public key, once the identity has loaded. */
    publicKey,
    /** False when the page has no WebCrypto, so no login is possible. */
    signingAvailable,
    /** How many messages the server replayed from the database on login. */
    historyCount,
  };
}
