export type CapturePoint = "A" | "B" | "C" | "D";

export type CapturedBody = {
  encoding: "utf8" | "base64";
  raw: string;
  byte_length: number;
  sha256: string;
};

export type StreamEvent = {
  event_name: string | null;
  event_sequence: number;
  raw_event: string;
  raw_event_json: unknown | null;
  arrived_at: string;
  text_delta: string | null;
  tool_arguments_delta: string | null;
  thinking_reasoning_delta: string | null;
  usage_event: unknown | null;
  completed_stop_event: boolean;
  error_event: unknown | null;
};

export type CaptureRecord = {
  schema_version: "acu-protocol-capture-v1";
  fixture_id: string;
  capture_id: string;
  capture_point: CapturePoint;
  connection: {
    started_at: string;
    request_ended_at: string | null;
    response_started_at: string | null;
    response_ended_at: string | null;
    interrupted_at: string | null;
    client_cancelled: boolean;
    client_cancelled_at: string | null;
  };
  request: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string | string[]>;
    body: CapturedBody;
  };
  response: {
    status_code: number | null;
    headers: Record<string, string | string[]>;
    body: CapturedBody;
    streaming_events: StreamEvent[];
  };
  ids: {
    upstream_request_id: string | null;
    new_api_request_id: string | null;
    acu_request_id: string | null;
    provider_request_id: string | null;
  };
  model: string | null;
  provider: string | null;
  protocol: "responses" | "messages" | "chat_completions" | "unknown";
  upstream_url: string;
  capture_error: string | null;
};

export type ProtocolFixtureManifest = {
  fixture_id: string;
  captured_at: string;
  client: "codex" | "claude-code";
  client_version: string;
  os: string;
  newapi_version: string;
  acu_commit: string;
  provider: string;
  requested_model: string;
  actual_model: string;
  protocol: "responses" | "messages" | "chat_completions";
  stream: boolean;
  scenario: string;
  request_count: number;
  contains_tools: boolean;
  contains_reasoning: boolean;
  contains_plan_signal: boolean;
  capture_points: CapturePoint[];
  sanitized: true;
  capture_status: "complete" | "partial" | "blocked" | "failed";
  chain?: string;
  provider_kind?: "real" | "mock";
  through_acu?: boolean;
  retry_setting?: number | "not_applicable" | "unknown";
  capture_completeness?: Record<CapturePoint, "captured" | "not_available" | "not_applicable">;
};
