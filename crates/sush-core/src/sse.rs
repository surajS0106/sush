//! Minimal Server-Sent Events parser.
//!
//! Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
//! Bytes are buffered until a full line arrives, so multi-byte UTF-8
//! characters split across network chunks are handled correctly.

use bytes::Bytes;
use futures::{Stream, StreamExt};

use crate::ProviderError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// The `event:` field, if the server sent one (Anthropic does; OpenAI doesn't).
    pub event: Option<String>,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed raw bytes; returns every event completed by this chunk.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
            if let Some(ev) = self.process_line(&line) {
                out.push(ev);
            }
        }
        out
    }

    /// Flush whatever is buffered when the stream ends without a trailing blank line.
    pub fn finish(&mut self) -> Option<SseEvent> {
        if !self.buf.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
            self.process_line(rest.trim_end_matches('\r'));
        }
        self.dispatch()
    }

    fn process_line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {} // id, retry: not needed for LLM streams
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        if self.data.is_empty() && self.event.is_none() {
            return None;
        }
        Some(SseEvent { event: self.event.take(), data: std::mem::take(&mut self.data).join("\n") })
    }
}

/// Adapt a byte stream (e.g. `reqwest::Response::bytes_stream`) into SSE events.
pub fn sse_events<S>(bytes: S) -> impl Stream<Item = Result<SseEvent, ProviderError>>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>>,
{
    async_stream::try_stream! {
        let mut parser = SseParser::new();
        futures::pin_mut!(bytes);
        while let Some(chunk) = bytes.next().await {
            for ev in parser.push(&chunk?) {
                yield ev;
            }
        }
        if let Some(ev) = parser.finish() {
            yield ev;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(events: &[SseEvent]) -> Vec<&str> {
        events.iter().map(|e| e.data.as_str()).collect()
    }

    #[test]
    fn parses_basic_events() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: one\n\ndata: two\n\n");
        assert_eq!(data(&evs), ["one", "two"]);
    }

    #[test]
    fn handles_crlf_named_events_and_comments() {
        let mut p = SseParser::new();
        let evs = p.push(b": ping\r\nevent: message_start\r\ndata: {}\r\n\r\n");
        assert_eq!(evs, [SseEvent { event: Some("message_start".into()), data: "{}".into() }]);
    }

    #[test]
    fn joins_multiline_data() {
        let mut p = SseParser::new();
        let evs = p.push(b"data: a\ndata: b\n\n");
        assert_eq!(data(&evs), ["a\nb"]);
    }

    #[test]
    fn buffers_across_chunks_including_split_utf8() {
        let mut p = SseParser::new();
        let bytes = "data: héllo\n\n".as_bytes();
        // Split inside the two-byte 'é'.
        let split = bytes.iter().position(|&b| b == 0xC3).unwrap() + 1;
        assert!(p.push(&bytes[..split]).is_empty());
        assert_eq!(data(&p.push(&bytes[split..])), ["héllo"]);
    }

    #[test]
    fn finish_flushes_unterminated_event() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: [DONE]").is_empty());
        assert_eq!(p.finish().unwrap().data, "[DONE]");
    }

    #[test]
    fn value_without_space_after_colon() {
        let mut p = SseParser::new();
        assert_eq!(data(&p.push(b"data:x\n\n")), ["x"]);
    }
}
