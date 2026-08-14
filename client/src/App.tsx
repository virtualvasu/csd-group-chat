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
          onSend={sendMessage}
          onTyping={setTyping}
        />
      ) : (
        <JoinScreen error={joinError} onJoin={join} />
      )}
    </div>
  );
}

export default App;
