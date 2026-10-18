"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// SpeechRecognition is still prefixed in some browsers and is not in lib.dom.
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void)
    | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

function recognitionConstructor() {
  const win = window as SpeechWindow;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

function unavailableReason(): string | null {
  if (!window.isSecureContext)
    return "Microphone access requires HTTPS or localhost. Open Optio using a secure address to dictate.";
  if (!recognitionConstructor())
    return "This browser doesn’t provide speech recognition. Use your keyboard’s dictation, or try a browser with speech recognition support.";
  return null;
}

/** Dictation edits a draft. It never sends a message or approves an action. */
export function useDictation(onTranscript: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "listening" | "stopping">("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopping = useRef(false);
  const callback = useRef(onTranscript);
  callback.current = onTranscript;

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stopping.current = false;
    const current = recognition.current;
    recognition.current = null;
    if (current) {
      current.onstart = current.onend = current.onerror = current.onresult = null;
      try {
        current.abort();
      } catch {
        /* Already ended by the browser. */
      }
    }
    setState("idle");
    setInterim("");
  }, []);

  useEffect(() => {
    const reason = unavailableReason();
    setUnavailable(reason);
    setSupported(!reason);
    return cancel;
  }, [cancel]);

  const start = useCallback(() => {
    if (recognition.current) return;
    const reason = unavailableReason();
    if (reason) {
      setUnavailable(reason);
      setError(reason);
      return;
    }
    let current: Recognition;
    try {
      const Constructor = recognitionConstructor()!;
      current = new Constructor();
    } catch {
      setError(
        "Your browser couldn’t open its speech service. Try keyboard dictation or another browser.",
      );
      return;
    }
    recognition.current = current;
    current.continuous = true;
    current.interimResults = true;
    current.lang = navigator.language || "en-US";
    let committed = 0;
    setError(null);
    setState("starting");
    const fail = (message: string) => {
      cancel();
      setError(message);
    };
    timer.current = setTimeout(
      () =>
        fail(
          "The microphone didn’t start. Check this site’s microphone permission and your browser’s speech recognition settings, then try again.",
        ),
      15000,
    );
    current.onstart = () => {
      if (timer.current) clearTimeout(timer.current);
      setState("listening");
      timer.current = setTimeout(
        () =>
          fail(
            "No speech reached the browser’s speech service. Check your microphone or try keyboard dictation.",
          ),
        30000,
      );
    };
    current.onresult = ({ results }) => {
      if (!stopping.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
      let draft = "";
      for (let i = 0; i < results.length; i++) {
        if (results[i].isFinal) {
          if (i >= committed) {
            callback.current(results[i][0].transcript.trim());
            committed = i + 1;
          }
        } else {
          draft += results[i][0].transcript;
        }
      }
      setInterim(draft);
    };
    current.onerror = ({ error: code }) => {
      fail(
        code === "not-allowed"
          ? "Microphone access was denied. Allow it in your browser’s site settings and try again."
          : code === "service-not-allowed"
            ? "Your browser’s speech recognition service is unavailable or disabled. Try keyboard dictation or another browser."
            : code === "aborted"
              ? "The browser stopped dictation. Try again, or use keyboard dictation."
              : code === "language-not-supported"
                ? "Your browser’s speech service doesn’t support the selected language. Try keyboard dictation."
                : code === "no-speech"
                  ? "No speech detected. Try dictating again."
                  : code === "audio-capture"
                    ? "No microphone is available. Check your microphone and try again."
                    : "Dictation couldn’t connect. Check your connection or type your request.",
      );
    };
    current.onend = () => {
      cancel();
      if (committed === 0)
        setError(
          "Dictation ended without any text. Check microphone permission and your browser’s speech service, or use keyboard dictation.",
        );
    };
    try {
      current.start();
    } catch {
      cancel();
      setError("Dictation couldn’t start. Check microphone access and try again.");
    }
  }, [cancel]);

  const stop = useCallback(() => {
    if (!recognition.current) return;
    if (state === "starting") {
      cancel();
      return;
    }
    stopping.current = true;
    setState("stopping");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      cancel();
      setError(
        "The speech service didn’t finish. Your captured words are still in the draft; you can edit and send them.",
      );
    }, 5000);
    // stop (unlike abort) delivers the final words before onend.
    try {
      recognition.current.stop();
    } catch {
      cancel();
      setError("Dictation stopped unexpectedly. Your draft is still here.");
    }
  }, [cancel, state]);

  return {
    supported,
    unavailable,
    state,
    active: state !== "idle",
    interim,
    error,
    start,
    stop,
    cancel,
  };
}
