import { useEffect, useRef, useState } from "react";

import { IconSend } from "./icons";
import { useStore } from "../state/store";

export function ChatPanel() {
  const history = useStore((s) => s.history);
  const sendMessage = useStore((s) => s.sendMessage);
  const hasApiKey = useStore((s) => s.hasApiKey);
  const busy = useStore((s) => s.busy);
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [history]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    void sendMessage(t);
  };

  return (
    <>
      <div className="label">Conversation</div>
      <div className="chat-scroll" ref={scroller}>
        {history.length === 0 && (
          <p className="chat-empty">
            Describe your project — the site and its size, which sides face the street, how many
            storeys, the rooms you need, and what matters to you. The drawing beside this is a worked
            example until you do.
          </p>
        )}
        {history.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.content}
          </div>
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input
          type="text"
          value={text}
          disabled={!hasApiKey || !!busy}
          placeholder={hasApiKey ? "Describe a change…" : "Add ANTHROPIC_API_KEY to .env to chat"}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={!hasApiKey || !!busy || !text.trim()} title="Send" aria-label="Send">
          <IconSend />
        </button>
      </form>
    </>
  );
}
