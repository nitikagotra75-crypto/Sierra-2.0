import { useEffect, useRef, useState } from "react";
import { api } from "../services/api";

/**
 * Subscribes to a project's live pipeline events over Server-Sent Events.
 * Calls onFinal when the pipeline reports its terminal event, so the caller
 * can refresh project/file state without this hook needing to know about it.
 */
export function useProjectEvents(projectId, onFinal) {
  // Events are stored with the project they belong to; switching project yields an empty list
  // immediately, with no reset effect.
  const [store, setStore] = useState({ projectId, list: [] });
  const esRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(api.eventsUrl(projectId));
    esRef.current = es;

    es.onmessage = (msg) => {
      let payload;
      try {
        payload = JSON.parse(msg.data);
      } catch {
        return; // keep-alive/ping frames aren't JSON
      }
      if (!payload.type) return;
      setStore((prev) => ({ projectId, list: [...(prev.projectId === projectId ? prev.list : []), payload] }));
      if (payload.type === "final" && onFinal) onFinal(payload);
    };

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return store.projectId === projectId ? store.list : [];
}
