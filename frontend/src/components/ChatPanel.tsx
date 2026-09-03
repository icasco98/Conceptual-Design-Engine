import { useEffect, useRef, useState } from "react";

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
    <section className="chat">
      <div className="chat-scroll" ref={scroller}>
        {history.length === 0 && (
          <p className="chat-empty">
            Describe your project: the site and its size, which sides face the street, how many
            storeys, the rooms you need, and what matters to you. The diagram on the right is a worked
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
          placeholder={hasApiKey ? "Describe your project — site, rooms, priorities…" : "Chat disabled: add ANTHROPIC_API_KEY to .env"}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={!hasApiKey || !!busy || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
