"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import { createLogClient, type WsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";

export interface TaskMessageEntry {
  id: string;
  taskId: string;
  userId?: string;
  content: string;
  mode: "soft" | "interrupt";
  createdAt: string;
  deliveredAt?: string | null;
  ackedAt?: string | null;
  deliveryError?: string | null;
  senderType?: "user" | "agent";
  senderName?: string | null;
  senderAddress?: string | null;
  user?: { id: string; displayName: string; avatarUrl?: string };
}

export function useTaskMessages(taskId: string) {
  const [messages, setMessages] = useState<TaskMessageEntry[]>([]);
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    // Load existing messages
    api
      .getTaskMessages(taskId)
      .then((res) => {
        setMessages(res.messages);
      })
      .catch(() => {});

    // Subscribe to real-time message events via existing log WebSocket
    const client = createLogClient(taskId, getWsTokenProvider());
    clientRef.current = client;

    client.on("task:message", (event: any) => {
      const msg: TaskMessageEntry = {
        id: event.messageId,
        taskId: event.taskId,
        userId: event.userId,
        content: event.content,
        mode: event.mode,
        createdAt: event.createdAt,
        senderType: event.senderType,
        senderName: event.senderName,
        senderAddress: event.senderAddress,
        user: event.userDisplayName
          ? { id: event.userId, displayName: event.userDisplayName }
          : undefined,
      };
      setMessages((prev) => {
        // Dedup by id
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    client.on("task:message_delivered", (event: any) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === event.messageId ? { ...m, deliveredAt: event.timestamp } : m)),
      );
    });

    client.on("task:message_acked", (event: any) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === event.messageId ? { ...m, ackedAt: event.timestamp } : m)),
      );
    });

    client.connect();

    return () => {
      client.disconnect();
    };
  }, [taskId]);

  return { messages };
}
