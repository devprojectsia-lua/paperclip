import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

const assistantEvent = (
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  text = "ok",
) =>
  JSON.stringify({
    type: "assistant",
    session_id: "sess-1",
    message: {
      content: [{ type: "text", text }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
      },
    },
  });

const initEvent = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  model: "claude-opus-4-7",
});

describe("parseClaudeStreamJson — partial usage on SIGKILL", () => {
  it("recovers usage from streamed assistant messages when no terminal result frame arrived", () => {
    const stdout = [
      initEvent,
      assistantEvent(1000, 200, 50, "step 1"),
      assistantEvent(1100, 250, 60, "step 2"),
      assistantEvent(1200, 300, 70, "step 3"),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);

    expect(parsed.resultJson).toBeNull();
    expect(parsed.usagePartial).toBe(true);
    expect(parsed.partialUsageMessages).toBe(3);
    expect(parsed.usage).toEqual({
      inputTokens: 3300,
      outputTokens: 750,
      cachedInputTokens: 180,
    });
    expect(parsed.summary).toBe("step 1\n\nstep 2\n\nstep 3");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.model).toBe("claude-opus-4-7");
  });

  it("returns null usage when no assistant messages were streamed before death", () => {
    const stdout = initEvent + "\n";
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.usagePartial).toBe(false);
    expect(parsed.partialUsageMessages).toBe(0);
    expect(parsed.usage).toBeNull();
    expect(parsed.resultJson).toBeNull();
  });

  it("skips assistant messages with zero usage so usagePartial stays false on no-op streams", () => {
    const stdout = [
      initEvent,
      assistantEvent(0, 0, 0, "thinking..."),
    ].join("\n");
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.usagePartial).toBe(false);
    expect(parsed.usage).toBeNull();
  });

  it("uses the terminal result frame's usage when the run completes normally and flags usagePartial=false", () => {
    const finalEvent = JSON.stringify({
      type: "result",
      session_id: "sess-1",
      result: "done",
      usage: { input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 200 },
      total_cost_usd: 0.123,
    });
    const stdout = [
      initEvent,
      assistantEvent(1000, 200, 50),
      assistantEvent(2000, 400, 100),
      finalEvent,
    ].join("\n");

    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.usagePartial).toBe(false);
    expect(parsed.usage).toEqual({
      inputTokens: 5000,
      outputTokens: 1000,
      cachedInputTokens: 200,
    });
    expect(parsed.costUsd).toBe(0.123);
    expect(parsed.resultJson).not.toBeNull();
  });

  it("handles a mid-token kill that truncates the final ndjson line", () => {
    const stdout =
      [initEvent, assistantEvent(800, 150, 40, "step 1")].join("\n") +
      '\n{"type":"assistant","session_id":"sess-1","message":{"co';
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.usagePartial).toBe(true);
    expect(parsed.partialUsageMessages).toBe(1);
    expect(parsed.usage).toEqual({
      inputTokens: 800,
      outputTokens: 150,
      cachedInputTokens: 40,
    });
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});
