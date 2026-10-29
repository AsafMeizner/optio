import { describe, it, expect } from "vitest";
import {
  PROGRAM_STATUS_QUERY_REPLY,
  isProgramStatusQuery,
  parseProgramStatus,
} from "../local/program-status.js";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("OSC 7501 program status", () => {
  it("answers the capability query with the five states and three kinds", () => {
    expect(isProgramStatusQuery("?")).toBe(true);
    expect(isProgramStatusQuery(" ? ")).toBe(true);
    expect(isProgramStatusQuery("?:states=idle")).toBe(true);
    expect(isProgramStatusQuery("state=working")).toBe(false);
    expect(PROGRAM_STATUS_QUERY_REPLY).toBe(
      "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\",
    );
  });

  it("parses a full report", () => {
    expect(
      parseProgramStatus(
        `state=blocked : kind=permission : progress=40 : app=claude : title=${b64("Bash")} : msg=${b64("Allow `rm -rf build`?")}`,
      ),
    ).toEqual({
      state: "blocked",
      id: null,
      kind: "permission",
      progress: 40,
      app: "claude",
      title: "Bash",
      msg: "Allow `rm -rf build`?",
    });
  });

  it("takes a record id path and the clear pseudo-state", () => {
    expect(parseProgramStatus("state=clear:id=agents/explore-1")).toMatchObject({
      state: "clear",
      id: "agents/explore-1",
    });
    expect(parseProgramStatus("state=clear")).toMatchObject({ state: "clear", id: null });
  });

  it("ignores a report with no or an unknown state", () => {
    expect(parseProgramStatus("app=claude")).toBeNull();
    expect(parseProgramStatus("state=waiting")).toBeNull();
    expect(parseProgramStatus("")).toBeNull();
  });

  it("skips a malformed pair, ignores unknown keys, last repeated key wins", () => {
    expect(parseProgramStatus("state=working:bogus:x-y=1:zebra=stripes:state=done")).toEqual({
      state: "done",
      id: null,
      kind: null,
      progress: null,
      app: null,
      title: null,
      msg: null,
    });
  });

  it("treats an unknown kind or an out-of-range progress as none", () => {
    expect(parseProgramStatus("state=blocked:kind=coffee:progress=250")).toMatchObject({
      kind: null,
      progress: null,
    });
    expect(parseProgramStatus("state=working:progress=-1")).toMatchObject({ progress: null });
  });

  it("drops the whole report when a decoded value carries a control character", () => {
    expect(parseProgramStatus(`state=done:msg=${b64("line one\nline two")}`)).toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64("\x1b[31mred")}`)).toBeNull();
  });

  it("drops the whole report on bad base64 or a value over its limit", () => {
    expect(parseProgramStatus("state=done:msg=ab=cd")).toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64("x".repeat(193))}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64("x".repeat(2049))}`)).toBeNull();
    expect(parseProgramStatus(`state=done:app=${"a".repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=done:id=${"a/".repeat(8)}a`)).toBeNull();
    expect(parseProgramStatus(`state=done:id=${"s".repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${"QUJD".repeat(1100)}`)).toBeNull();
  });

  it("decodes UTF-8 and accepts unpadded base64", () => {
    const msg = "Waiting on you — 日本語 ✓";
    expect(parseProgramStatus(`state=done:msg=${b64(msg).replace(/=+$/, "")}`)).toMatchObject({
      msg,
    });
  });
});
