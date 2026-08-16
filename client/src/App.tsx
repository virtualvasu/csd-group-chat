import { JoinScreen } from "@/components/JoinScreen";
import { ChatScreen } from "@/components/ChatScreen";
import { useChatSocket } from "@/hooks/useChatSocket";

function App() {
  const {
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
    publicKey,
    signingAvailable,
    historyCount,
  } = useChatSocket();

  return (
    <div className="h-svh">
      {hasJoined ? (
        <ChatScreen
          username={username}
          connectionStatus={connectionStatus}
          onlineUsers={onlineUsers}
          typingUsers={typingUsers}
          timeline={timeline}
          historyCount={historyCount}
          onSend={sendMessage}
          onTyping={setTyping}
        />
      ) : (
        <JoinScreen
          error={joinError}
          publicKey={publicKey}
          signingAvailable={signingAvailable}
          onJoin={join}
        />
      )}
    </div>
  );
}

export default App;
